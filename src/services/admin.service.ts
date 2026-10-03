import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { BillingInterval } from "../config/plans";
import * as planService from "./plan.service";
import * as subscriptions from "./subscription.service";
import { ConflictError, normalizeEmail, normalizeUsername, validatePassword } from "./registration.service";

/**
 * Admin provisioning.
 *
 * An admin still picks a plan -- that's what sets the factory's channel and
 * mockup limits -- but no payment is taken and no Stripe subscription is
 * created. These accounts are `provisioned_by = 'admin'` and start `active`,
 * which is how the rest of the app knows never to chase them for payment.
 */

export interface AdminFactoryRow {
  id: string;
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  username: string | null;
  plan: string;
  planName: string | null;
  interval: BillingInterval;
  status: subscriptions.FactoryStatus;
  provisionedBy: subscriptions.ProvisionedBy;
  channelLimit: number;
  monthlyMockupLimit: number;
  currentPeriodEnd: Date | null;
  createdAt: Date;
}

export async function listFactories(): Promise<AdminFactoryRow[]> {
  const result = await pool.query(
    `SELECT f.*, p.name AS plan_name, p.tier AS plan_tier
       FROM factories f
       LEFT JOIN plans p ON p.code = f.plan
      ORDER BY f.created_at DESC`
  );

  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    country: row.country,
    email: row.email,
    phone: row.phone,
    username: row.username,
    plan: row.plan,
    planName: row.plan_tier ?? row.plan_name ?? null,
    interval: (row.billing_interval ?? "monthly") as BillingInterval,
    status: (row.status ?? "active") as subscriptions.FactoryStatus,
    provisionedBy: (row.provisioned_by ?? "admin") as subscriptions.ProvisionedBy,
    channelLimit: Number(row.channel_limit ?? 1),
    monthlyMockupLimit: Number(row.monthly_mockup_limit ?? 0),
    currentPeriodEnd: row.current_period_end ?? null,
    createdAt: row.created_at,
  }));
}

export interface CreateFactoryInput {
  name: string;
  type?: string;
  country?: string;
  email: string;
  phone?: string;
  password: string;
  username: string;
  plan: string;
  interval?: BillingInterval;
}

export async function createFactory(input: CreateFactoryInput) {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("Factory name is required");

  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  const plan = await planService.requirePlan(input.plan);
  const interval: BillingInterval = input.interval === "annual" ? "annual" : "monthly";

  const passwordHash = await bcrypt.hash(password, 10);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const factoryResult = await client.query(
      `INSERT INTO factories
         (name, type, country, email, phone, username,
          plan, billing_interval, status, provisioned_by,
          channel_limit, monthly_mockup_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'active', 'admin', $9, $10)
       RETURNING *`,
      [
        name,
        String(input.type ?? "").trim(),
        String(input.country ?? "").trim(),
        email,
        String(input.phone ?? "").trim(),
        username,
        plan.code,
        interval,
        plan.channelLimit,
        plan.monthlyMockupLimit,
      ]
    );
    const factory = factoryResult.rows[0];

    await client.query(
      `INSERT INTO users (email, password_hash, role, factory_id)
       VALUES ($1, $2, 'factory', $3)`,
      [email, passwordHash, factory.id]
    );

    await client.query(
      `INSERT INTO factory_channels (factory_id, channel, enabled)
       VALUES ($1, 'website', TRUE)
       ON CONFLICT (factory_id, channel) DO NOTHING`,
      [factory.id]
    );

    await client.query("COMMIT");

    return {
      factory: {
        id: factory.id,
        name: factory.name,
        type: factory.type,
        country: factory.country,
        email: factory.email,
        phone: factory.phone,
        username: factory.username,
        plan: factory.plan,
        interval,
        status: factory.status,
      },
      loginEmail: email,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw translateDuplicate(err as Error);
  } finally {
    client.release();
  }
}

/**
 * Moves a factory onto a different plan without touching Stripe.
 *
 * For an admin-provisioned account that's the whole story. For a paying one it
 * changes the limits but NOT what Stripe bills, so it's the right tool for a
 * comp or a correction and the wrong one for an actual upgrade -- the customer
 * changes their own plan from the billing page, which does go through Stripe.
 */
export async function setFactoryPlan(
  factoryId: string,
  planCode: string,
  interval?: BillingInterval
) {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current) throw new Error("Factory not found");

  return subscriptions.applyPlan(
    factoryId,
    planCode,
    interval ?? current.interval
  );
}

export async function setFactoryStatus(
  factoryId: string,
  status: subscriptions.FactoryStatus
) {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current) throw new Error("Factory not found");

  await subscriptions.setStatus(factoryId, status);
  return subscriptions.getSubscription(factoryId);
}

function translateDuplicate(err: Error): Error {
  const message = err.message || "";
  if (message.includes("duplicate key") || message.includes("unique constraint")) {
    if (message.includes("username")) {
      return new ConflictError("That subdomain is already taken");
    }
    return new ConflictError("An account with that email already exists");
  }
  return err;
}
