import Stripe from "stripe";
import { pool } from "../config/db";
import { env } from "../config/env";
import { billingEnabled, stripe, stripeDate } from "../config/stripe";
import { BillingInterval } from "../config/plans";
import * as planService from "./plan.service";
import * as subscriptions from "./subscription.service";

/**
 * Everything that talks to Stripe about a *factory's* subscription. (Pushing
 * the price list itself into Stripe lives in plan.service.ts.)
 *
 * The flow this backs is: a visitor registers (factory row created as
 * `pending`, subdomain reserved) -> they're sent to Stripe Checkout -> Stripe
 * calls our webhook -> the factory flips to `active` and can sign in.
 *
 * The webhook, not the browser redirect, is what grants access. A user can
 * close the tab before being redirected back, and a redirect URL can be forged;
 * a signed webhook can't be.
 */

export { BillingDisabledError } from "../config/stripe";

/**
 * Maps a Stripe subscription status onto ours.
 *
 * `trialing` counts as active so adding a trial later needs no change here.
 * `incomplete` means the first payment never succeeded, which for us is
 * indistinguishable from never having paid -- so it stays `pending`.
 */
function statusFromStripe(
  status: Stripe.Subscription.Status
): subscriptions.FactoryStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    case "incomplete":
    case "paused":
    default:
      return "pending";
  }
}

async function getOrCreateCustomer(factoryId: string): Promise<string> {
  const existing = await subscriptions.getSubscription(factoryId);
  if (!existing) throw new Error("Factory not found");
  if (existing.stripeCustomerId) return existing.stripeCustomerId;

  const factory = await pool.query(
    "SELECT name, email, username FROM factories WHERE id = $1",
    [factoryId]
  );
  const row = factory.rows[0];
  if (!row) throw new Error("Factory not found");

  const customer = await stripe().customers.create({
    name: row.name,
    email: row.email,
    metadata: { factory_id: factoryId, username: row.username ?? "" },
  });

  await subscriptions.setStripeCustomer(factoryId, customer.id);
  return customer.id;
}

export interface CheckoutSessionResult {
  url: string;
  sessionId: string;
}

/**
 * Opens a Stripe Checkout session for a factory's subscription.
 *
 * `factory_id` rides along in both the session and the subscription metadata so
 * the webhook can match a payment back to the right account without trusting
 * anything the browser sends.
 */
export async function createCheckoutSession(
  factoryId: string,
  planCode: string,
  interval: BillingInterval
): Promise<CheckoutSessionResult> {
  const priceId = await planService.stripePriceIdFor(planCode, interval);
  const customerId = await getOrCreateCustomer(factoryId);

  const session = await stripe().checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: factoryId,
    metadata: { factory_id: factoryId, plan: planCode, interval },
    subscription_data: {
      metadata: { factory_id: factoryId, plan: planCode, interval },
    },
    allow_promotion_codes: true,
    billing_address_collection: "auto",
    success_url: `${env.frontendUrl}/register/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${env.frontendUrl}/register/cancelled?factory=${factoryId}`,
  });

  if (!session.url) throw new Error("Stripe did not return a checkout URL");
  return { url: session.url, sessionId: session.id };
}

/** The Stripe-hosted page where a customer updates their card or cancels. */
export async function createPortalSession(
  factoryId: string,
  returnPath = "/dashboard/billing"
): Promise<string> {
  const customerId = await getOrCreateCustomer(factoryId);
  const session = await stripe().billingPortal.sessions.create({
    customer: customerId,
    return_url: `${env.frontendUrl}${returnPath}`,
  });
  return session.url;
}

/**
 * Switches an existing subscription to a different plan or interval, with
 * Stripe prorating the difference. A factory with no subscription yet goes
 * through Checkout instead.
 */
export async function changePlan(
  factoryId: string,
  planCode: string,
  interval: BillingInterval
): Promise<{ changed: true } | CheckoutSessionResult> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current) throw new Error("Factory not found");

  if (!current.stripeSubscriptionId) {
    return createCheckoutSession(factoryId, planCode, interval);
  }

  const priceId = await planService.stripePriceIdFor(planCode, interval);
  const subscription = await stripe().subscriptions.retrieve(
    current.stripeSubscriptionId
  );
  const item = subscription.items.data[0];
  if (!item) throw new Error("Subscription has no line item to update");

  await stripe().subscriptions.update(current.stripeSubscriptionId, {
    items: [{ id: item.id, price: priceId }],
    proration_behavior: "create_prorations",
    metadata: { factory_id: factoryId, plan: planCode, interval },
  });

  // Reflect it immediately so the dashboard doesn't show a stale plan while we
  // wait for `customer.subscription.updated` to arrive.
  await subscriptions.applyPlan(factoryId, planCode, interval);
  return { changed: true };
}

/** Flags the subscription to stop at the end of the paid period. */
export async function cancelAtPeriodEnd(
  factoryId: string,
  cancel: boolean
): Promise<void> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current?.stripeSubscriptionId) {
    throw new Error("This factory has no active subscription");
  }
  await stripe().subscriptions.update(current.stripeSubscriptionId, {
    cancel_at_period_end: cancel,
  });
  await pool.query("UPDATE factories SET cancel_at_period_end = $2 WHERE id = $1", [
    factoryId,
    cancel,
  ]);
}

export interface InvoiceSummary {
  id: string;
  number: string | null;
  amountPaid: number;
  currency: string;
  status: string | null;
  createdAt: string;
  invoiceUrl: string | null;
  pdfUrl: string | null;
}

export async function listInvoices(factoryId: string): Promise<InvoiceSummary[]> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current?.stripeCustomerId) return [];

  const invoices = await stripe().invoices.list({
    customer: current.stripeCustomerId,
    limit: 24,
  });

  return invoices.data.map((invoice) => ({
    id: invoice.id ?? "",
    number: invoice.number ?? null,
    amountPaid: (invoice.amount_paid ?? 0) / 100,
    currency: (invoice.currency ?? "usd").toUpperCase(),
    status: invoice.status ?? null,
    createdAt: new Date((invoice.created ?? 0) * 1000).toISOString(),
    invoiceUrl: invoice.hosted_invoice_url ?? null,
    pdfUrl: invoice.invoice_pdf ?? null,
  }));
}

/**
 * Reads a completed Checkout session so the success page can confirm what the
 * visitor just bought -- and, if the webhook hasn't landed yet, activate the
 * factory from the session itself. The session id is only obtainable by
 * finishing checkout, and we re-fetch it from Stripe rather than trusting the
 * query string, so this is a safe fallback rather than a bypass.
 */
export async function resolveCheckoutSession(sessionId: string): Promise<{
  status: string;
  paid: boolean;
  factory: { id: string; name: string; username: string | null; email: string } | null;
  plan: string | null;
  interval: BillingInterval | null;
}> {
  const session = await stripe().checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });

  const factoryId = session.metadata?.factory_id ?? session.client_reference_id ?? null;
  const paid = session.payment_status === "paid" || session.status === "complete";

  if (!factoryId) {
    return {
      status: session.status ?? "unknown",
      paid,
      factory: null,
      plan: null,
      interval: null,
    };
  }

  if (paid) await activateFromSession(session, factoryId);

  const result = await pool.query(
    "SELECT id, name, username, email, plan, billing_interval FROM factories WHERE id = $1",
    [factoryId]
  );
  const row = result.rows[0];

  return {
    status: session.status ?? "unknown",
    paid,
    factory: row
      ? { id: row.id, name: row.name, username: row.username, email: row.email }
      : null,
    plan: row?.plan ?? null,
    interval: (row?.billing_interval as BillingInterval) ?? null,
  };
}

async function activateFromSession(
  session: Stripe.Checkout.Session,
  factoryId: string
): Promise<void> {
  const planCode = session.metadata?.plan || "starter";
  const interval = (session.metadata?.interval as BillingInterval) || "monthly";

  const subscriptionId =
    typeof session.subscription === "string"
      ? session.subscription
      : session.subscription?.id ?? null;

  let periodEnd: Date | null = null;
  let cancelAtEnd = false;

  if (subscriptionId) {
    const sub = await stripe().subscriptions.retrieve(subscriptionId);
    periodEnd = stripeDate(sub.items.data[0]?.current_period_end);
    cancelAtEnd = Boolean(sub.cancel_at_period_end);
  }

  await subscriptions.applyPlan(factoryId, planCode, interval, {
    status: "active",
    stripeCustomerId:
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null,
    stripeSubscriptionId: subscriptionId,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: cancelAtEnd,
  });
}

// --- Webhooks ----------------------------------------------------------------

export function constructWebhookEvent(rawBody: Buffer, signature: string): Stripe.Event {
  if (!env.stripe.webhookSecret) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not set");
  }
  return stripe().webhooks.constructEvent(rawBody, signature, env.stripe.webhookSecret);
}

/**
 * Records the event id first and bails if we've seen it before. Stripe retries
 * on any non-2xx and can deliver the same event more than once, so without this
 * a retry could re-apply a plan change the customer has since reversed.
 */
async function claimEvent(
  event: Stripe.Event,
  factoryId: string | null
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO subscription_events (stripe_event_id, type, factory_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (stripe_event_id) DO NOTHING
     RETURNING id`,
    [event.id, event.type, factoryId, JSON.stringify(event.data.object)]
  );
  return (result.rowCount ?? 0) > 0;
}

async function factoryIdForSubscription(
  sub: Stripe.Subscription
): Promise<string | null> {
  if (sub.metadata?.factory_id) return sub.metadata.factory_id;

  const bySubscription = await subscriptions.findByStripeSubscription(sub.id);
  if (bySubscription) return bySubscription.factoryId;

  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const byCustomer = await subscriptions.findByStripeCustomer(customerId);
  return byCustomer?.factoryId ?? null;
}

async function syncSubscription(sub: Stripe.Subscription): Promise<void> {
  const factoryId = await factoryIdForSubscription(sub);
  if (!factoryId) {
    console.warn(`[billing] No factory matches Stripe subscription ${sub.id}`);
    return;
  }

  const priceId = sub.items.data[0]?.price?.id ?? "";
  const resolved = priceId ? await planService.findPlanByStripePriceId(priceId) : null;

  // An unrecognised price means the subscription was pointed at something this
  // catalog doesn't know -- an archived price, or one created in the Stripe
  // dashboard. Keep the stored plan rather than guessing, but still sync
  // status and dates so access and renewal stay correct.
  const planCode = resolved?.plan.code ?? sub.metadata?.plan ?? null;
  const interval =
    resolved?.interval ?? (sub.metadata?.interval as BillingInterval) ?? null;

  const status = statusFromStripe(sub.status);
  const periodEnd = stripeDate(sub.items.data[0]?.current_period_end);
  const planExists = planCode ? Boolean(await planService.findPlan(planCode)) : false;

  if (planCode && interval && planExists) {
    await subscriptions.applyPlan(factoryId, planCode, interval, {
      status,
      stripeSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
    });
  } else {
    await pool.query(
      `UPDATE factories SET
         status = $2,
         stripe_subscription_id = $3,
         current_period_end = COALESCE($4, current_period_end),
         cancel_at_period_end = $5
       WHERE id = $1`,
      [factoryId, status, sub.id, periodEnd, Boolean(sub.cancel_at_period_end)]
    );
  }
}

export async function handleWebhookEvent(event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as Stripe.Checkout.Session;
      const factoryId =
        session.metadata?.factory_id ?? session.client_reference_id ?? null;

      if (!(await claimEvent(event, factoryId))) return;
      if (!factoryId) {
        console.warn(
          `[billing] checkout.session.completed with no factory_id: ${session.id}`
        );
        return;
      }
      await activateFromSession(session, factoryId);
      console.log(`[billing] Factory ${factoryId} activated from checkout ${session.id}`);
      return;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      const sub = event.data.object as Stripe.Subscription;
      const factoryId = await factoryIdForSubscription(sub);
      if (!(await claimEvent(event, factoryId))) return;
      await syncSubscription(sub);
      return;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const factory = customerId
        ? await subscriptions.findByStripeCustomer(customerId)
        : null;

      if (!(await claimEvent(event, factory?.factoryId ?? null))) return;
      if (factory && factory.status === "active") {
        await subscriptions.setStatus(factory.factoryId, "past_due");
        console.log(`[billing] Factory ${factory.factoryId} marked past_due`);
      }
      return;
    }

    case "invoice.paid": {
      const invoice = event.data.object as Stripe.Invoice;
      const customerId =
        typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id;
      const factory = customerId
        ? await subscriptions.findByStripeCustomer(customerId)
        : null;

      if (!(await claimEvent(event, factory?.factoryId ?? null))) return;
      if (factory && factory.status === "past_due") {
        await subscriptions.setStatus(factory.factoryId, "active");
        console.log(`[billing] Factory ${factory.factoryId} recovered to active`);
      }
      return;
    }

    default:
      // Everything else is bookkeeping we don't act on.
      return;
  }
}

/** What the dashboard billing page renders. */
export async function getBillingOverview(factoryId: string) {
  const overview = await subscriptions.getPlanOverview(factoryId);
  const invoices = billingEnabled ? await listInvoices(factoryId).catch(() => []) : [];

  return {
    plan: overview.plan
      ? {
          code: overview.plan.code,
          tier: overview.plan.tier,
          name: overview.plan.name,
          tagline: overview.plan.tagline,
          features: overview.plan.features,
          channelNote: overview.plan.channelNote,
        }
      : null,
    interval: overview.subscription.interval,
    price: overview.price,
    status: overview.subscription.status,
    provisionedBy: overview.subscription.provisionedBy,
    currentPeriodEnd: overview.subscription.currentPeriodEnd,
    cancelAtPeriodEnd: overview.subscription.cancelAtPeriodEnd,
    hasSubscription: Boolean(overview.subscription.stripeSubscriptionId),
    billingEnabled,
    usage: overview.usage,
    channels: overview.channels,
    invoices,
  };
}
