import { pool } from "../config/db";
import { env } from "../config/env";
import {
  BillingDisabledError,
  billingEnabled,
  isMissingResource,
  paddle,
  toMinorUnits,
} from "../config/paddle";
import {
  BillingInterval,
  Plan,
  PlanInput,
  priceForInterval,
} from "../config/plans";

/**
 * The price list, as data.
 *
 * Plans are rows an admin creates and edits, so everything downstream -- what a
 * tier costs, how many channels it unlocks, how many mockups it allows -- is
 * read from here rather than from a constant. Each plan also carries the Paddle
 * product and price ids that back it, created on demand by `syncPlanToPaddle`.
 *
 * Unlike Stripe, Paddle prices are mutable, so an edit updates the existing
 * price in place. Paddle keeps billing current subscribers at the amount they
 * signed up for until their subscription is explicitly changed, so editing the
 * public price list still never silently re-bills an existing customer.
 */

export class PlanNotFoundError extends Error {
  code = "PLAN_NOT_FOUND";
  constructor(code: string) {
    super(`Unknown plan: ${code}`);
    this.name = "PlanNotFoundError";
  }
}

export class PlanInUseError extends Error {
  code = "PLAN_IN_USE";
  constructor(message: string) {
    super(message);
    this.name = "PlanInUseError";
  }
}

export class PlanValidationError extends Error {
  code = "VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "PlanValidationError";
  }
}

function mapPlan(row: Record<string, any>): Plan {
  return {
    id: row.id,
    code: row.code,
    tier: row.tier,
    name: row.name,
    tagline: row.tagline ?? "",
    monthlyPrice: Number(row.monthly_price ?? 0),
    annualPrice: Number(row.annual_price ?? 0),
    channelLimit: Number(row.channel_limit ?? 1),
    monthlyMockupLimit: Number(row.monthly_mockup_limit ?? 200),
    channelNote: row.channel_note ?? "",
    features: Array.isArray(row.features) ? row.features : [],
    targetBuyer: row.target_buyer ?? "",
    popular: Boolean(row.popular),
    sortOrder: Number(row.sort_order ?? 0),
    active: Boolean(row.active),
    paddleProductId: row.paddle_product_id ?? null,
    paddleMonthlyPriceId: row.paddle_monthly_price_id ?? null,
    paddleAnnualPriceId: row.paddle_annual_price_id ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPlans(options: { activeOnly?: boolean } = {}): Promise<Plan[]> {
  const where = options.activeOnly ? "WHERE active = TRUE" : "";
  const result = await pool.query(
    `SELECT * FROM plans ${where} ORDER BY sort_order, monthly_price`
  );
  return result.rows.map(mapPlan);
}

export async function findPlan(code: string): Promise<Plan | null> {
  const result = await pool.query("SELECT * FROM plans WHERE code = $1", [
    String(code ?? "").trim().toLowerCase(),
  ]);
  return result.rows[0] ? mapPlan(result.rows[0]) : null;
}

export async function requirePlan(code: string): Promise<Plan> {
  const plan = await findPlan(code);
  if (!plan) throw new PlanNotFoundError(code);
  return plan;
}

/** The shape the marketing site and signup form read. No Paddle ids. */
export function toPublicPlan(plan: Plan) {
  return {
    code: plan.code,
    tier: plan.tier,
    name: plan.name,
    tagline: plan.tagline,
    monthlyPrice: plan.monthlyPrice,
    annualPrice: plan.annualPrice,
    channelLimit: plan.channelLimit,
    monthlyMockupLimit: plan.monthlyMockupLimit,
    channelNote: plan.channelNote,
    features: plan.features,
    targetBuyer: plan.targetBuyer,
    popular: plan.popular,
    sortOrder: plan.sortOrder,
  };
}

export async function listPublicPlans() {
  const plans = await listPlans({ activeOnly: true });
  return plans.map(toPublicPlan);
}

// --- Validation --------------------------------------------------------------

const CODE_REGEX = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

function normalizeCode(raw: unknown): string {
  const code = String(raw ?? "").trim().toLowerCase();
  if (!CODE_REGEX.test(code)) {
    throw new PlanValidationError(
      "Plan code must be 3-40 characters using lowercase letters, numbers and hyphens, and can't start or end with a hyphen"
    );
  }
  return code;
}

function positiveNumber(value: unknown, field: string, { min = 0 } = {}): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num < min) {
    throw new PlanValidationError(`${field} must be a number of at least ${min}`);
  }
  return num;
}

function normalizeFeatures(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw)
    ? raw
    : String(raw)
        .split("\n")
        .map((line) => line.trim());
  return list.map((f) => String(f).trim()).filter(Boolean);
}

/** Validates and normalizes an admin's plan payload. */
function normalizeInput(body: Record<string, any>, existing?: Plan): PlanInput {
  const tier = String(body.tier ?? existing?.tier ?? "").trim();
  const name = String(body.name ?? existing?.name ?? "").trim();
  if (!tier) throw new PlanValidationError("Tier label is required");
  if (!name) throw new PlanValidationError("Plan name is required");

  return {
    code: existing ? existing.code : normalizeCode(body.code),
    tier,
    name,
    tagline: String(body.tagline ?? existing?.tagline ?? "").trim(),
    monthlyPrice: positiveNumber(
      body.monthlyPrice ?? existing?.monthlyPrice ?? 0,
      "Monthly price"
    ),
    annualPrice: positiveNumber(
      body.annualPrice ?? existing?.annualPrice ?? 0,
      "Annual price"
    ),
    channelLimit: Math.floor(
      positiveNumber(body.channelLimit ?? existing?.channelLimit ?? 1, "Channel limit", {
        min: 1,
      })
    ),
    monthlyMockupLimit: Math.floor(
      positiveNumber(
        body.monthlyMockupLimit ?? existing?.monthlyMockupLimit ?? 0,
        "Monthly mockup limit"
      )
    ),
    channelNote: String(body.channelNote ?? existing?.channelNote ?? "").trim(),
    features: body.features === undefined ? existing?.features ?? [] : normalizeFeatures(body.features),
    targetBuyer: String(body.targetBuyer ?? existing?.targetBuyer ?? "").trim(),
    popular: body.popular === undefined ? existing?.popular ?? false : Boolean(body.popular),
    sortOrder: Math.floor(Number(body.sortOrder ?? existing?.sortOrder ?? 0)) || 0,
    active: body.active === undefined ? existing?.active ?? true : Boolean(body.active),
  };
}

// --- Writes ------------------------------------------------------------------

export async function createPlan(body: Record<string, any>): Promise<Plan> {
  const input = normalizeInput(body);

  const existing = await findPlan(input.code);
  if (existing) {
    throw new PlanValidationError(`A plan with the code "${input.code}" already exists`);
  }

  const result = await pool.query(
    `INSERT INTO plans
       (code, tier, name, tagline, monthly_price, annual_price,
        channel_limit, monthly_mockup_limit, channel_note, features,
        target_buyer, popular, sort_order, active)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13, $14)
     RETURNING *`,
    [
      input.code,
      input.tier,
      input.name,
      input.tagline,
      input.monthlyPrice,
      input.annualPrice,
      input.channelLimit,
      input.monthlyMockupLimit,
      input.channelNote,
      JSON.stringify(input.features),
      input.targetBuyer,
      input.popular,
      input.sortOrder,
      input.active,
    ]
  );

  const plan = mapPlan(result.rows[0]);
  return syncPlanToPaddle(plan).catch((err) => {
    // A Paddle hiccup shouldn't lose the admin's work. The plan exists and can
    // be re-synced; only checkout for this plan is unavailable until it is.
    console.error(`[plans] Paddle sync failed for "${plan.code}":`, err);
    return plan;
  });
}

export async function updatePlan(code: string, body: Record<string, any>): Promise<Plan> {
  const existing = await requirePlan(code);
  const input = normalizeInput(body, existing);

  const result = await pool.query(
    `UPDATE plans SET
       tier = $2, name = $3, tagline = $4,
       monthly_price = $5, annual_price = $6,
       channel_limit = $7, monthly_mockup_limit = $8,
       channel_note = $9, features = $10::jsonb, target_buyer = $11,
       popular = $12, sort_order = $13, active = $14,
       updated_at = NOW()
     WHERE code = $1
     RETURNING *`,
    [
      existing.code,
      input.tier,
      input.name,
      input.tagline,
      input.monthlyPrice,
      input.annualPrice,
      input.channelLimit,
      input.monthlyMockupLimit,
      input.channelNote,
      JSON.stringify(input.features),
      input.targetBuyer,
      input.popular,
      input.sortOrder,
      input.active,
    ]
  );

  const plan = mapPlan(result.rows[0]);

  // Limits are denormalized onto each factory so hot paths (mockup quota,
  // channel toggles) don't join. Push the new numbers out to everyone on this
  // plan, then trim any channels that the new limit no longer allows.
  await pool.query(
    `UPDATE factories SET channel_limit = $2, monthly_mockup_limit = $3 WHERE plan = $1`,
    [plan.code, plan.channelLimit, plan.monthlyMockupLimit]
  );
  await pool.query(
    `UPDATE factory_channels fc SET enabled = FALSE, updated_at = NOW()
      WHERE fc.enabled = TRUE
        AND fc.factory_id IN (SELECT id FROM factories WHERE plan = $1)
        AND fc.id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (PARTITION BY factory_id ORDER BY created_at) AS rn
              FROM factory_channels
             WHERE enabled = TRUE
               AND factory_id IN (SELECT id FROM factories WHERE plan = $1)
          ) ranked WHERE rn <= $2
        )`,
    [plan.code, plan.channelLimit]
  );

  return syncPlanToPaddle(plan).catch((err) => {
    console.error(`[plans] Paddle sync failed for "${plan.code}":`, err);
    return plan;
  });
}

/**
 * Removes a plan. Refused while any factory is on it -- deleting would leave
 * those accounts pointing at a tier with no limits to read. Archive it
 * (`active: false`) instead, which hides it from the pricing page while
 * existing subscribers keep working.
 */
export async function deletePlan(code: string): Promise<void> {
  const plan = await requirePlan(code);

  const inUse = await pool.query(
    "SELECT COUNT(*)::int AS count FROM factories WHERE plan = $1",
    [plan.code]
  );
  const count = inUse.rows[0].count as number;
  if (count > 0) {
    throw new PlanInUseError(
      `${count} factory/factories are on the "${plan.code}" plan. Deactivate the plan instead of deleting it.`
    );
  }

  if (plan.paddleProductId && billingEnabled) {
    await paddle()
      .products.archive(plan.paddleProductId)
      .catch((err) => console.error("[plans] Could not archive Paddle product:", err));
  }

  await pool.query("DELETE FROM plans WHERE code = $1", [plan.code]);
}

// --- Paddle sync -------------------------------------------------------------

/**
 * Makes Paddle match the row: creates the product and its two prices if they
 * don't exist, and updates them in place when they do.
 *
 * A plan priced at 0 for an interval gets no price for that interval -- that is
 * how an admin offers, say, monthly-only billing. An existing price is archived
 * in that case so checkout cannot reach it.
 */
export async function syncPlanToPaddle(plan: Plan): Promise<Plan> {
  if (!billingEnabled) return plan;

  const client = paddle();
  let productId = plan.paddleProductId;

  if (productId) {
    // A stored id can belong to a different Paddle account or environment --
    // switching between sandbox and production leaves every id here pointing at
    // something that does not exist. Treat that as "not synced yet" and make a
    // fresh product, rather than failing and leaving the plan unsellable.
    try {
      await client.products.update(productId, {
        name: plan.tier + " \u2014 " + plan.name,
        description: plan.tagline || null,
        customData: { plan_code: plan.code },
      });
    } catch (err) {
      if (!isMissingResource(err)) throw err;
      console.warn(
        `[plans] Paddle product ${productId} for "${plan.code}" is not in this account/environment -- recreating.`
      );
      productId = null;
    }
  }

  if (!productId) {
    const product = await client.products.create({
      name: plan.tier + " \u2014 " + plan.name,
      // "standard" covers SaaS. Paddle uses this to work out tax treatment, and
      // the categories beyond "standard" need approval on your account first.
      taxCategory: "standard",
      description: plan.tagline || null,
      customData: { plan_code: plan.code },
    });
    productId = product.id;
  }

  const monthlyPriceId = await ensurePrice(
    productId,
    plan,
    "monthly",
    plan.paddleMonthlyPriceId
  );
  const annualPriceId = await ensurePrice(
    productId,
    plan,
    "annual",
    plan.paddleAnnualPriceId
  );

  const result = await pool.query(
    `UPDATE plans SET
       paddle_product_id = $2,
       paddle_monthly_price_id = $3,
       paddle_annual_price_id = $4,
       updated_at = NOW()
     WHERE code = $1
     RETURNING *`,
    [plan.code, productId, monthlyPriceId, annualPriceId]
  );

  return mapPlan(result.rows[0]);
}

async function ensurePrice(
  productId: string,
  plan: Plan,
  interval: BillingInterval,
  currentPriceId: string | null
): Promise<string | null> {
  const client = paddle();
  const amount = priceForInterval(plan, interval);
  const paddleInterval = interval === "annual" ? "year" : "month";

  if (amount <= 0) {
    // Price removed: archive whatever was there so checkout cannot reach it.
    if (currentPriceId) {
      await client.prices.archive(currentPriceId).catch(() => undefined);
    }
    return null;
  }

  const unitPrice = {
    amount: toMinorUnits(amount),
    currencyCode: env.paddle.currency as "USD",
  };
  const description =
    plan.tier + " \u2014 " + (interval === "annual" ? "Annual" : "Monthly");

  if (currentPriceId) {
    try {
      // Paddle prices are mutable, so an amount change is an update rather than
      // the create-and-archive dance Stripe forces.
      const updated = await client.prices.update(currentPriceId, {
        description,
        unitPrice,
        customData: { plan_code: plan.code, interval },
      });
      return updated.id;
    } catch (err) {
      if (!isMissingResource(err)) throw err;
      // Belongs to another account/environment -- fall through and recreate.
    }
  }

  const created = await client.prices.create({
    productId,
    description,
    unitPrice,
    billingCycle: { interval: paddleInterval, frequency: 1 },
    customData: { plan_code: plan.code, interval },
  });

  return created.id;
}

/** Pushes every plan into Paddle. Backs `npm run paddle:sync`. */
export async function syncAllPlansToPaddle(): Promise<Plan[]> {
  const plans = await listPlans();
  const synced: Plan[] = [];
  for (const plan of plans) {
    synced.push(await syncPlanToPaddle(plan));
  }
  return synced;
}

/**
 * The Paddle price id to charge for a plan/interval, creating it on the fly if
 * the plan has never been synced.
 */
export async function paddlePriceIdFor(
  planCode: string,
  interval: BillingInterval
): Promise<string> {
  // Without a key a sync is a no-op, which would otherwise surface here as the
  // misleading "this plan has no price" rather than "billing isn't set up".
  if (!billingEnabled) throw new BillingDisabledError();

  let plan = await requirePlan(planCode);

  const field = interval === "annual" ? "paddleAnnualPriceId" : "paddleMonthlyPriceId";
  if (!plan[field]) {
    plan = await syncPlanToPaddle(plan);
  }

  const priceId = plan[field];
  if (!priceId) {
    throw new PlanValidationError(
      `The "${plan.code}" plan has no ${interval} price. Set one in the admin panel before selling it.`
    );
  }
  return priceId;
}

/** Reverse lookup used by the webhook to tell which plan a subscription is on. */
export async function findPlanByPaddlePriceId(
  priceId: string
): Promise<{ plan: Plan; interval: BillingInterval } | null> {
  const result = await pool.query(
    `SELECT * FROM plans
      WHERE paddle_monthly_price_id = $1 OR paddle_annual_price_id = $1
      LIMIT 1`,
    [priceId]
  );
  if (!result.rows[0]) return null;

  const plan = mapPlan(result.rows[0]);
  return {
    plan,
    interval: plan.paddleAnnualPriceId === priceId ? "annual" : "monthly",
  };
}
