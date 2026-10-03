import Stripe from "stripe";
import { env } from "./env";

/**
 * The shared Stripe client.
 *
 * It lives apart from billing.service.ts because plan.service.ts also needs it
 * (to push an admin's price changes into Stripe), and the two services already
 * depend on each other in the other direction.
 */

export class BillingDisabledError extends Error {
  code = "BILLING_DISABLED";
  constructor() {
    super(
      "Billing is not configured on this server. Set STRIPE_SECRET_KEY to enable self-serve signup."
    );
    this.name = "BillingDisabledError";
  }
}

/**
 * Billing is optional at boot so the rest of the app still runs -- and an admin
 * can still provision factories by hand -- on a machine with no Stripe keys.
 * Every billing endpoint checks this and returns a clear 503 rather than
 * failing somewhere deep inside the SDK.
 */
export const billingEnabled = Boolean(env.stripe.secretKey);

if (!billingEnabled) {
  console.warn(
    "[billing] STRIPE_SECRET_KEY is not set -- self-serve signup and billing endpoints are disabled."
  );
}

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (!billingEnabled) throw new BillingDisabledError();
  if (!client) client = new Stripe(env.stripe.secretKey);
  return client;
}

/** Stripe timestamps are seconds since the epoch; Postgres wants a Date. */
export function stripeDate(seconds: number | null | undefined): Date | null {
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}
