import { pool } from "../config/db";
import { DEFAULT_PLANS } from "../config/plans";

/**
 * Turns the platform into a self-serve SaaS.
 *
 * Two things arrive here. First, an admin-managed `plans` catalog: prices,
 * limits and feature lists are rows, not code, so an admin can add a tier or
 * change a price without a deploy. Second, every factory gains a plan and a
 * lifecycle status that gates access to the dashboard.
 *
 * `factories.status` meanings:
 *   pending   -- signed up, subdomain reserved, has NOT paid yet. Cannot use
 *                the dashboard; the login response sends them to checkout.
 *   active    -- paid (or admin-provisioned). Full access.
 *   past_due  -- Stripe failed to collect. Still allowed in, shown a banner, so
 *                a lapsed card doesn't lock a factory out of its own data.
 *   canceled  -- subscription ended. Data is kept, access is not.
 *   suspended -- switched off by an admin.
 *
 * `provisioned_by` separates the two creation paths. An 'admin' factory has no
 * Stripe subscription by design and is never chased for payment.
 */
export const billingSchema = `
-- The price list. Stripe ids live here rather than in the environment because
-- an admin can create a plan at runtime, which then has to be pushed to Stripe.
CREATE TABLE IF NOT EXISTS plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) NOT NULL UNIQUE,
  tier VARCHAR(60) NOT NULL,
  name VARCHAR(120) NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  monthly_price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  annual_price DECIMAL(10, 2) NOT NULL DEFAULT 0,
  channel_limit INTEGER NOT NULL DEFAULT 1,
  monthly_mockup_limit INTEGER NOT NULL DEFAULT 200,
  channel_note TEXT NOT NULL DEFAULT '',
  features JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_buyer TEXT NOT NULL DEFAULT '',
  popular BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  stripe_product_id VARCHAR(255),
  stripe_monthly_price_id VARCHAR(255),
  stripe_annual_price_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plans_active ON plans(active, sort_order);
CREATE INDEX IF NOT EXISTS idx_plans_monthly_price_id ON plans(stripe_monthly_price_id);
CREATE INDEX IF NOT EXISTS idx_plans_annual_price_id ON plans(stripe_annual_price_id);

ALTER TABLE factories ADD COLUMN IF NOT EXISTS plan VARCHAR(40) NOT NULL DEFAULT 'starter';
ALTER TABLE factories ADD COLUMN IF NOT EXISTS billing_interval VARCHAR(10) NOT NULL DEFAULT 'monthly';
ALTER TABLE factories ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE factories ADD COLUMN IF NOT EXISTS provisioned_by VARCHAR(20) NOT NULL DEFAULT 'admin';
ALTER TABLE factories ADD COLUMN IF NOT EXISTS channel_limit INTEGER NOT NULL DEFAULT 1;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
ALTER TABLE factories ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255);
ALTER TABLE factories ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_factories_stripe_customer ON factories(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_factories_stripe_subscription ON factories(stripe_subscription_id);
CREATE INDEX IF NOT EXISTS idx_factories_status ON factories(status);
CREATE INDEX IF NOT EXISTS idx_factories_plan ON factories(plan);

-- A factory's active sales channels. The plan caps how many may be enabled at
-- once; rows persist when disabled so re-enabling keeps the saved config.
CREATE TABLE IF NOT EXISTS factory_channels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  channel VARCHAR(30) NOT NULL CHECK (channel IN ('website', 'whatsapp', 'telegram', 'email', 'custom')),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (factory_id, channel)
);

CREATE INDEX IF NOT EXISTS idx_factory_channels_factory ON factory_channels(factory_id);

-- Stripe delivers webhooks at least once and retries on any non-2xx. Recording
-- each event id makes a replay a no-op instead of a repeated plan change.
CREATE TABLE IF NOT EXISTS subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id VARCHAR(255) NOT NULL UNIQUE,
  type VARCHAR(100) NOT NULL,
  factory_id UUID REFERENCES factories(id) ON DELETE SET NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_subscription_events_factory ON subscription_events(factory_id);
`;

type Queryable = {
  query: (
    text: string,
    params?: unknown[]
  ) => Promise<{ rows: any[]; rowCount: number | null }>;
};

/** True only on the very first run, before `plan` has been added to factories. */
async function isFirstRun(client: Queryable): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name = 'factories' AND column_name = 'plan'`
  );
  return result.rows.length === 0;
}

/**
 * Writes the three starting tiers. `ON CONFLICT DO NOTHING` keyed on `code`
 * means an admin's later edits are never overwritten by a re-run -- this seeds
 * an empty catalog, it doesn't reset one.
 */
export async function seedPlans(client: Queryable): Promise<void> {
  let inserted = 0;
  for (const plan of DEFAULT_PLANS) {
    const result = await client.query(
      `INSERT INTO plans
         (code, tier, name, tagline, monthly_price, annual_price,
          channel_limit, monthly_mockup_limit, channel_note, features,
          target_buyer, popular, sort_order, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
       ON CONFLICT (code) DO NOTHING`,
      [
        plan.code,
        plan.tier,
        plan.name,
        plan.tagline,
        plan.monthlyPrice,
        plan.annualPrice,
        plan.channelLimit,
        plan.monthlyMockupLimit,
        plan.channelNote,
        JSON.stringify(plan.features),
        plan.targetBuyer,
        plan.popular,
        plan.sortOrder,
        plan.active,
      ]
    );
    inserted += result.rowCount ?? 0;
  }
  if (inserted > 0) console.log(`Seeded ${inserted} plan(s)`);
}

/**
 * Brings existing rows in line with the new columns.
 *
 * Factories that predate billing were all created by an admin, so they keep
 * full access ('active', provisioned_by 'admin') and are put on the top tier --
 * the least surprising outcome is that nobody loses a capability they had.
 *
 * This runs only on `firstRun`. On any later run every factory already has a
 * deliberately chosen plan, and re-applying it would promote real customers.
 */
async function backfill(client: Queryable, firstRun: boolean) {
  if (firstRun) {
    const top = await client.query(
      `SELECT code, channel_limit, monthly_mockup_limit
         FROM plans WHERE active = TRUE
        ORDER BY monthly_price DESC, sort_order DESC LIMIT 1`
    );
    const plan = top.rows[0];
    if (plan) {
      const grandfathered = await client.query(
        `UPDATE factories
            SET plan = $1,
                status = 'active',
                provisioned_by = 'admin',
                channel_limit = $2,
                monthly_mockup_limit = $3`,
        [plan.code, plan.channel_limit, plan.monthly_mockup_limit]
      );
      if (grandfathered.rowCount) {
        console.log(
          `Grandfathered ${grandfathered.rowCount} existing factory/factories onto the "${plan.code}" plan`
        );
      }
    }
  }

  // Every factory gets the website chat widget as its first channel -- that is
  // the channel the storefront already serves today.
  const seeded = await client.query(
    `INSERT INTO factory_channels (factory_id, channel, enabled)
     SELECT id, 'website', TRUE FROM factories
     ON CONFLICT (factory_id, channel) DO NOTHING`
  );
  if (seeded.rowCount) {
    console.log(`Seeded the website channel for ${seeded.rowCount} factory/factories`);
  }
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const firstRun = await isFirstRun(client);
    await client.query(billingSchema);
    await seedPlans(client);
    await backfill(client, firstRun);
    await client.query("COMMIT");
    console.log("Billing migration applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Only self-execute when run directly (init.ts imports the schema instead).
if (process.argv[1] && process.argv[1].includes("migrate-billing")) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error("Billing migration failed:", err);
      process.exit(1);
    });
}
