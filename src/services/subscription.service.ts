import { pool } from "../config/db";
import { BillingInterval, Plan, priceForInterval } from "../config/plans";
import * as planService from "./plan.service";

/**
 * The database side of subscriptions: what plan a factory is on, whether it may
 * use the product right now, and how much of its quota it has spent.
 *
 * Stripe itself is never touched here -- see billing.service.ts for that. The
 * split matters because an admin-provisioned factory has a plan and limits but
 * no Stripe subscription at all.
 *
 * Note that `channel_limit` and `monthly_mockup_limit` are copied onto each
 * factory rather than read through a join. The hot paths (every mockup, every
 * channel toggle) check them, and plan.service pushes the new values out when
 * an admin edits a plan, so the copy can't go stale.
 */

export type FactoryStatus =
  | "pending"
  | "active"
  | "past_due"
  | "canceled"
  | "suspended";

export type ProvisionedBy = "self_serve" | "admin";

export const FACTORY_STATUSES: FactoryStatus[] = [
  "pending",
  "active",
  "past_due",
  "canceled",
  "suspended",
];

export function isFactoryStatus(value: unknown): value is FactoryStatus {
  return typeof value === "string" && FACTORY_STATUSES.includes(value as FactoryStatus);
}

export interface FactorySubscription {
  factoryId: string;
  plan: string;
  interval: BillingInterval;
  status: FactoryStatus;
  provisionedBy: ProvisionedBy;
  channelLimit: number;
  monthlyMockupLimit: number;
  paddleCustomerId: string | null;
  paddleSubscriptionId: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

/**
 * Statuses that may use the dashboard. `past_due` is included on purpose: a
 * failed card shouldn't lock a factory out of data it already owns, so it gets
 * a warning banner instead of a closed door.
 */
const ACTIVE_STATUSES: FactoryStatus[] = ["active", "past_due"];

export function isUsable(status: FactoryStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

export function mapSubscription(row: Record<string, any>): FactorySubscription {
  return {
    factoryId: row.id,
    plan: row.plan ?? "starter",
    interval: (row.billing_interval ?? "monthly") as BillingInterval,
    status: (row.status ?? "active") as FactoryStatus,
    provisionedBy: (row.provisioned_by ?? "admin") as ProvisionedBy,
    channelLimit: Number(row.channel_limit ?? 1),
    monthlyMockupLimit: Number(row.monthly_mockup_limit ?? 200),
    paddleCustomerId: row.paddle_customer_id ?? null,
    paddleSubscriptionId: row.paddle_subscription_id ?? null,
    currentPeriodEnd: row.current_period_end ?? null,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
  };
}

export async function getSubscription(
  factoryId: string
): Promise<FactorySubscription | null> {
  const result = await pool.query("SELECT * FROM factories WHERE id = $1", [factoryId]);
  return result.rows[0] ? mapSubscription(result.rows[0]) : null;
}

export async function findByPaddleCustomer(
  customerId: string
): Promise<FactorySubscription | null> {
  const result = await pool.query(
    "SELECT * FROM factories WHERE paddle_customer_id = $1",
    [customerId]
  );
  return result.rows[0] ? mapSubscription(result.rows[0]) : null;
}

export async function findByPaddleSubscription(
  subscriptionId: string
): Promise<FactorySubscription | null> {
  const result = await pool.query(
    "SELECT * FROM factories WHERE paddle_subscription_id = $1",
    [subscriptionId]
  );
  return result.rows[0] ? mapSubscription(result.rows[0]) : null;
}

/**
 * Writes a plan onto a factory, deriving the quota columns from the catalog so
 * limits can never drift out of sync with what the customer is paying for.
 */
export async function applyPlan(
  factoryId: string,
  planCode: string,
  interval: BillingInterval,
  extra: {
    status?: FactoryStatus;
    paddleCustomerId?: string | null;
    paddleSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    cancelAtPeriodEnd?: boolean;
  } = {}
): Promise<FactorySubscription> {
  const plan = await planService.requirePlan(planCode);

  const result = await pool.query(
    `UPDATE factories SET
       plan = $2,
       billing_interval = $3,
       channel_limit = $4,
       monthly_mockup_limit = $5,
       status = COALESCE($6, status),
       paddle_customer_id = COALESCE($7, paddle_customer_id),
       paddle_subscription_id = COALESCE($8, paddle_subscription_id),
       current_period_end = COALESCE($9, current_period_end),
       cancel_at_period_end = COALESCE($10, cancel_at_period_end)
     WHERE id = $1
     RETURNING *`,
    [
      factoryId,
      plan.code,
      interval,
      plan.channelLimit,
      plan.monthlyMockupLimit,
      extra.status ?? null,
      extra.paddleCustomerId ?? null,
      extra.paddleSubscriptionId ?? null,
      extra.currentPeriodEnd ?? null,
      extra.cancelAtPeriodEnd ?? null,
    ]
  );

  if (!result.rows[0]) throw new Error("Factory not found");

  // Dropping to a smaller plan can leave more channels on than the new tier
  // allows. Rather than refusing the downgrade, keep the oldest N and switch
  // the rest off, so the account is never in a state the plan forbids.
  await enforceChannelLimit(factoryId, plan.channelLimit);

  return mapSubscription(result.rows[0]);
}

export async function setStatus(
  factoryId: string,
  status: FactoryStatus
): Promise<void> {
  await pool.query("UPDATE factories SET status = $2 WHERE id = $1", [factoryId, status]);
}

export async function setPaddleCustomer(
  factoryId: string,
  customerId: string
): Promise<void> {
  await pool.query("UPDATE factories SET paddle_customer_id = $2 WHERE id = $1", [
    factoryId,
    customerId,
  ]);
}

// --- Usage -------------------------------------------------------------------

export interface PlanUsage {
  mockups: { used: number; limit: number; remaining: number };
  channels: { used: number; limit: number; remaining: number };
}

export async function getUsage(
  factoryId: string,
  subscription: FactorySubscription
): Promise<PlanUsage> {
  const [mockupResult, channelResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS count FROM mockups
        WHERE factory_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [factoryId]
    ),
    pool.query(
      `SELECT COUNT(*)::int AS count FROM factory_channels
        WHERE factory_id = $1 AND enabled = TRUE`,
      [factoryId]
    ),
  ]);

  const mockupsUsed = mockupResult.rows[0]?.count ?? 0;
  const channelsUsed = channelResult.rows[0]?.count ?? 0;

  return {
    mockups: {
      used: mockupsUsed,
      limit: subscription.monthlyMockupLimit,
      remaining: Math.max(0, subscription.monthlyMockupLimit - mockupsUsed),
    },
    channels: {
      used: channelsUsed,
      limit: subscription.channelLimit,
      remaining: Math.max(0, subscription.channelLimit - channelsUsed),
    },
  };
}

/** Mockups generated by this factory in the current calendar month. */
export async function countMockupsThisMonth(factoryId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM mockups
      WHERE factory_id = $1 AND created_at >= date_trunc('month', CURRENT_DATE)`,
    [factoryId]
  );
  return result.rows[0]?.count ?? 0;
}

export interface MockupQuota {
  allowed: boolean;
  used: number;
  limit: number;
  remaining: number;
}

export async function checkMockupQuota(factoryId: string): Promise<MockupQuota> {
  const subscription = await getSubscription(factoryId);
  const limit = subscription?.monthlyMockupLimit ?? 200;
  const used = await countMockupsThisMonth(factoryId);
  return {
    allowed: used < limit,
    used,
    limit,
    remaining: Math.max(0, limit - used),
  };
}

// --- Channels ----------------------------------------------------------------

export type ChannelKey = "website" | "whatsapp" | "telegram" | "email" | "custom";

export const CHANNEL_KEYS: ChannelKey[] = [
  "website",
  "whatsapp",
  "telegram",
  "email",
  "custom",
];

export function isChannelKey(value: unknown): value is ChannelKey {
  return typeof value === "string" && CHANNEL_KEYS.includes(value as ChannelKey);
}

export interface FactoryChannel {
  id: string;
  channel: ChannelKey;
  enabled: boolean;
  config: Record<string, unknown>;
  createdAt: Date;
}

function mapChannel(row: Record<string, any>): FactoryChannel {
  return {
    id: row.id,
    channel: row.channel,
    enabled: Boolean(row.enabled),
    config: row.config ?? {},
    createdAt: row.created_at,
  };
}

export async function listChannels(factoryId: string): Promise<FactoryChannel[]> {
  const result = await pool.query(
    "SELECT * FROM factory_channels WHERE factory_id = $1 ORDER BY created_at",
    [factoryId]
  );
  return result.rows.map(mapChannel);
}

export class PlanLimitError extends Error {
  code = "PLAN_LIMIT";
  constructor(message: string) {
    super(message);
    this.name = "PlanLimitError";
  }
}

/**
 * Turns a channel on or off. Enabling is refused once the plan's channel limit
 * is reached -- the check and the write share one transaction, and the factory
 * row is locked first, so two concurrent requests can't both slip past it.
 */
export async function setChannelEnabled(
  factoryId: string,
  channel: ChannelKey,
  enabled: boolean,
  config?: Record<string, unknown>
): Promise<FactoryChannel> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const factoryResult = await client.query(
      "SELECT channel_limit FROM factories WHERE id = $1 FOR UPDATE",
      [factoryId]
    );
    if (!factoryResult.rows[0]) throw new Error("Factory not found");
    const limit = Number(factoryResult.rows[0].channel_limit);

    if (enabled) {
      const countResult = await client.query(
        `SELECT COUNT(*)::int AS count FROM factory_channels
          WHERE factory_id = $1 AND enabled = TRUE AND channel <> $2`,
        [factoryId, channel]
      );
      const active = countResult.rows[0].count as number;
      if (active >= limit) {
        const plural = limit === 1 ? "channel" : "channels";
        throw new PlanLimitError(
          `Your plan allows ${limit} active ${plural}. Turn one off, or upgrade to add another.`
        );
      }
    }

    const result = await client.query(
      `INSERT INTO factory_channels (factory_id, channel, enabled, config)
       VALUES ($1, $2, $3, COALESCE($4::jsonb, '{}'::jsonb))
       ON CONFLICT (factory_id, channel) DO UPDATE
         SET enabled = EXCLUDED.enabled,
             config = COALESCE($4::jsonb, factory_channels.config),
             updated_at = NOW()
       RETURNING *`,
      [factoryId, channel, enabled, config ? JSON.stringify(config) : null]
    );

    await client.query("COMMIT");
    return mapChannel(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** After a downgrade: keep the oldest `limit` channels on, switch the rest off. */
export async function enforceChannelLimit(
  factoryId: string,
  limit: number
): Promise<void> {
  await pool.query(
    `UPDATE factory_channels SET enabled = FALSE, updated_at = NOW()
      WHERE factory_id = $1
        AND enabled = TRUE
        AND id NOT IN (
          SELECT id FROM factory_channels
           WHERE factory_id = $1 AND enabled = TRUE
           ORDER BY created_at
           LIMIT $2
        )`,
    [factoryId, limit]
  );
}

/** Everything the billing page needs: plan definition, price, usage, channels. */
export async function getPlanOverview(factoryId: string): Promise<{
  subscription: FactorySubscription;
  plan: Plan | null;
  price: number;
  usage: PlanUsage;
  channels: FactoryChannel[];
}> {
  const subscription = await getSubscription(factoryId);
  if (!subscription) throw new Error("Factory not found");

  const [plan, usage, channels] = await Promise.all([
    planService.findPlan(subscription.plan),
    getUsage(factoryId, subscription),
    listChannels(factoryId),
  ]);

  return {
    subscription,
    plan,
    price: plan ? priceForInterval(plan, subscription.interval) : 0,
    usage,
    channels,
  };
}
