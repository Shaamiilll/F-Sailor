import { Environment, Paddle } from "@paddle/paddle-node-sdk";
import { env } from "./env";

/**
 * The shared Paddle client.
 *
 * Paddle is a Merchant of Record: it sells to the customer, handles global tax,
 * and pays us out. That is why it replaced Stripe here -- it settles the
 * cross-border problem (our Stripe account could not charge overseas buyers at
 * all) and it can offer Alipay and WeChat Pay to customers in China, which
 * Stripe could not.
 *
 * It lives apart from billing.service.ts because plan.service.ts also needs it,
 * to push an admin's price changes into Paddle.
 */

export class BillingDisabledError extends Error {
  code = "BILLING_DISABLED";
  constructor() {
    super(
      "Billing is not configured on this server. Set PADDLE_API_KEY to enable self-serve signup."
    );
    this.name = "BillingDisabledError";
  }
}

/**
 * Billing is optional at boot so the rest of the app still runs -- and an admin
 * can still provision factories by hand -- on a machine with no Paddle key.
 * Every billing endpoint checks this and returns a clear 503 rather than
 * failing somewhere deep inside the SDK.
 */
export const billingEnabled = Boolean(env.paddle.apiKey);

if (!billingEnabled) {
  console.warn(
    "[billing] PADDLE_API_KEY is not set -- self-serve signup and billing endpoints are disabled."
  );
}

let client: Paddle | null = null;

export function paddle(): Paddle {
  if (!billingEnabled) throw new BillingDisabledError();
  if (!client) {
    client = new Paddle(env.paddle.apiKey, {
      environment:
        env.paddle.environment === "production"
          ? Environment.production
          : Environment.sandbox,
    });
  }
  return client;
}

/**
 * Paddle sends and expects money as a string of minor units ("3000" = $30.00),
 * which avoids the float rounding a decimal would invite.
 */
export function toMinorUnits(amount: number): string {
  return String(Math.round(amount * 100));
}

export function fromMinorUnits(amount: string | null | undefined): number {
  return amount ? Number(amount) / 100 : 0;
}

/** True for Paddle's "not found" error -- an id from another account or env. */
export function isMissingResource(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  const status = (err as { statusCode?: number })?.statusCode;
  return code === "entity_not_found" || status === 404;
}
