import { pool } from "../config/db";
import { billingSchema, seedPlans } from "./migrate-billing";

/**
 * Moves the billing columns from Stripe to Paddle.
 *
 * The payment processor changed, not the data model: a factory still has a
 * customer id, a subscription id and a plan still has a product and two price
 * ids. Only the provider behind them is different, so this renames the columns
 * in place rather than dropping and re-adding them.
 *
 * The stored *values* are Stripe ids, which mean nothing to Paddle. They are
 * cleared: plans get re-synced by `npm run paddle:sync`, and factories with a
 * live Stripe subscription would need migrating in Paddle anyway -- something
 * no script should guess at. Paying factories keep `status = 'active'`, so
 * nobody loses access; they simply have no Paddle subscription attached until
 * they go through checkout again.
 *
 * Idempotent: every rename is guarded on the old column still existing.
 */
export const paddleRenameSchema = `
DO $$
BEGIN
  -- factories -----------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'factories' AND column_name = 'stripe_customer_id') THEN
    ALTER TABLE factories RENAME COLUMN stripe_customer_id TO paddle_customer_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'factories' AND column_name = 'stripe_subscription_id') THEN
    ALTER TABLE factories RENAME COLUMN stripe_subscription_id TO paddle_subscription_id;
  END IF;

  -- plans ---------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plans' AND column_name = 'stripe_product_id') THEN
    ALTER TABLE plans RENAME COLUMN stripe_product_id TO paddle_product_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plans' AND column_name = 'stripe_monthly_price_id') THEN
    ALTER TABLE plans RENAME COLUMN stripe_monthly_price_id TO paddle_monthly_price_id;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'plans' AND column_name = 'stripe_annual_price_id') THEN
    ALTER TABLE plans RENAME COLUMN stripe_annual_price_id TO paddle_annual_price_id;
  END IF;

  -- subscription_events --------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_name = 'subscription_events' AND column_name = 'stripe_event_id') THEN
    ALTER TABLE subscription_events RENAME COLUMN stripe_event_id TO provider_event_id;
  END IF;
END $$;

-- Old index names would be misleading after the rename.
DROP INDEX IF EXISTS idx_factories_stripe_customer;
DROP INDEX IF EXISTS idx_factories_stripe_subscription;
DROP INDEX IF EXISTS idx_plans_monthly_price_id;
DROP INDEX IF EXISTS idx_plans_annual_price_id;
`;

/**
 * Wipes identifiers that belong to the old processor. A Stripe id handed to
 * Paddle is not merely useless -- it would make the sync think a plan is
 * already linked and skip creating the Paddle product it actually needs.
 */
const clearStripeIds = `
UPDATE plans
   SET paddle_product_id = NULL,
       paddle_monthly_price_id = NULL,
       paddle_annual_price_id = NULL
 WHERE paddle_product_id LIKE 'prod_%'
    OR paddle_monthly_price_id LIKE 'price_%'
    OR paddle_annual_price_id LIKE 'price_%';

UPDATE factories
   SET paddle_customer_id = NULL
 WHERE paddle_customer_id LIKE 'cus_%';

UPDATE factories
   SET paddle_subscription_id = NULL
 WHERE paddle_subscription_id LIKE 'sub_%'
   AND paddle_subscription_id NOT LIKE 'sub_%_%';
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Rename first: the billing schema below adds the paddle_* columns only if
    // they are still missing, so on an existing database this turns its Stripe
    // columns into Paddle ones instead of leaving two empty sets side by side.
    await client.query(paddleRenameSchema);
    await client.query(billingSchema);
    await seedPlans(client);

    const cleared = await client.query(clearStripeIds);
    if (cleared) console.log("Cleared any leftover Stripe identifiers");

    await client.query("COMMIT");
    console.log("Paddle migration applied successfully");
    console.log('Next: run "npm run paddle:sync" to create the catalog in Paddle.');
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && process.argv[1].includes("migrate-paddle")) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error("Paddle migration failed:", err);
      process.exit(1);
    });
}
