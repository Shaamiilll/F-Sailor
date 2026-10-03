import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { BillingInterval } from "../config/plans";
import * as billing from "./billing.service";
import * as planService from "./plan.service";
import * as subscriptions from "./subscription.service";

/**
 * Self-serve signup: a visitor creates their own factory, no admin involved.
 *
 * The factory row is written before payment so the subdomain is reserved and
 * nothing the visitor typed is lost if checkout fails -- but it lands in
 * `status = 'pending'`, which the subscription middleware refuses, so an unpaid
 * account can't use the product. Stripe's webhook is what flips it to active.
 */

// 3-32 chars: a leading and trailing alphanumeric with 1-30 in between. The
// middle section is NOT optional -- making it so would let a single character
// through, contradicting the rule the error message states.
const USERNAME_REGEX = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Subdomains the platform needs for itself, plus the usual infrastructure
 * hostnames. Handing any of these to a tenant would shadow a real route.
 */
const RESERVED_USERNAMES = new Set([
  "www",
  "app",
  "api",
  "admin",
  "dashboard",
  "store",
  "login",
  "register",
  "signup",
  "pricing",
  "billing",
  "checkout",
  "account",
  "support",
  "help",
  "docs",
  "blog",
  "status",
  "mail",
  "smtp",
  "ftp",
  "static",
  "assets",
  "cdn",
  "demo",
  "test",
  "staging",
  "kayanflow",
]);

export class ValidationError extends Error {
  code = "VALIDATION";
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class ConflictError extends Error {
  code = "CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/** Normalizes and validates a requested subdomain, or throws with the reason. */
export function normalizeUsername(raw: unknown): string {
  const username = String(raw ?? "").trim().toLowerCase();

  if (!username) throw new ValidationError("A subdomain is required");
  if (!USERNAME_REGEX.test(username)) {
    throw new ValidationError(
      "Subdomain must be 3-32 characters using lowercase letters, numbers and hyphens, and can't start or end with a hyphen"
    );
  }
  if (RESERVED_USERNAMES.has(username)) {
    throw new ValidationError("That subdomain is reserved");
  }
  return username;
}

export function normalizeEmail(raw: unknown): string {
  const email = String(raw ?? "").trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ValidationError("A valid email address is required");
  }
  return email;
}

export function validatePassword(raw: unknown): string {
  const password = String(raw ?? "");
  if (password.length < 8) {
    throw new ValidationError("Password must be at least 8 characters");
  }
  return password;
}

export interface UsernameAvailability {
  username: string;
  available: boolean;
  reason?: string;
}

export async function checkUsername(raw: unknown): Promise<UsernameAvailability> {
  let username: string;
  try {
    username = normalizeUsername(raw);
  } catch (err) {
    return {
      username: String(raw ?? "").trim().toLowerCase(),
      available: false,
      reason: (err as Error).message,
    };
  }

  const result = await pool.query("SELECT 1 FROM factories WHERE username = $1", [
    username,
  ]);

  return result.rows.length > 0
    ? { username, available: false, reason: "That subdomain is already taken" }
    : { username, available: true };
}

export interface RegisterInput {
  factoryName: string;
  factoryType?: string;
  country?: string;
  phone?: string;
  username: string;
  email: string;
  password: string;
  plan: string;
  interval: BillingInterval;
}

export interface RegisterResult {
  factory: {
    id: string;
    name: string;
    username: string;
    email: string;
    plan: string;
    interval: BillingInterval;
    status: subscriptions.FactoryStatus;
  };
  transactionId: string;
}

/**
 * Creates the pending factory and returns the Paddle transaction id the browser
 * opens the checkout overlay with.
 *
 * If Paddle refuses to open the transaction, the factory and user rows are
 * rolled back: leaving a pending account behind would hold the subdomain
 * hostage with no way for the visitor to ever pay for it.
 */
export async function register(input: RegisterInput): Promise<RegisterResult> {
  const name = String(input.factoryName ?? "").trim();
  if (!name) throw new ValidationError("Factory name is required");

  const username = normalizeUsername(input.username);
  const email = normalizeEmail(input.email);
  const password = validatePassword(input.password);
  const plan = await planService.requirePlan(input.plan);
  const interval: BillingInterval = input.interval === "annual" ? "annual" : "monthly";

  const passwordHash = await bcrypt.hash(password, 10);
  const client = await pool.connect();

  let factoryId: string;
  try {
    await client.query("BEGIN");

    const factoryResult = await client.query(
      `INSERT INTO factories
         (name, type, country, email, phone, username,
          plan, billing_interval, status, provisioned_by,
          channel_limit, monthly_mockup_limit)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', 'self_serve', $9, $10)
       RETURNING id, name, username, email, plan, billing_interval, status`,
      [
        name,
        String(input.factoryType ?? "").trim(),
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
    factoryId = factory.id;

    await client.query(
      `INSERT INTO users (email, password_hash, role, factory_id)
       VALUES ($1, $2, 'factory', $3)`,
      [email, passwordHash, factoryId]
    );

    // Every factory starts with the website chat widget -- the one channel the
    // storefront serves out of the box, and one that fits even Starter.
    await client.query(
      `INSERT INTO factory_channels (factory_id, channel, enabled)
       VALUES ($1, 'website', TRUE)
       ON CONFLICT (factory_id, channel) DO NOTHING`,
      [factoryId]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw translateDuplicate(err as Error);
  } finally {
    client.release();
  }

  try {
    const session = await billing.createCheckoutSession(factoryId, plan.code, interval);
    const stored = await subscriptions.getSubscription(factoryId);

    return {
      factory: {
        id: factoryId,
        name,
        username,
        email,
        plan: plan.code,
        interval,
        status: stored?.status ?? "pending",
      },
      transactionId: session.transactionId,
    };
  } catch (err) {
    // No transaction means no way to pay -- don't squat on the subdomain.
    await pool
      .query("DELETE FROM factories WHERE id = $1", [factoryId])
      .catch((cleanupErr) =>
        console.error(
          `[register] Failed to roll back factory ${factoryId} after checkout error:`,
          cleanupErr
        )
      );
    throw err;
  }
}

/**
 * Re-opens checkout for a factory that registered but never paid, so a visitor
 * who abandoned the overlay can finish from the login screen.
 */
export async function resumeCheckout(
  factoryId: string,
  plan?: string,
  interval?: BillingInterval
): Promise<string> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current) throw new ValidationError("Factory not found");
  if (current.status === "active") {
    throw new ValidationError("This factory already has an active subscription");
  }

  const session = await billing.createCheckoutSession(
    factoryId,
    plan ?? current.plan,
    interval ?? current.interval
  );
  return session.transactionId;
}

/** Turns Postgres unique-violation noise into a message a visitor can act on. */
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
