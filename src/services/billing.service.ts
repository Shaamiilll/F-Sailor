import type { EventEntity, Subscription, Transaction } from "@paddle/paddle-node-sdk";
import { pool } from "../config/db";
import { env } from "../config/env";
import { billingEnabled, fromMinorUnits, paddle } from "../config/paddle";
import { BillingInterval } from "../config/plans";
import * as planService from "./plan.service";
import * as subscriptions from "./subscription.service";

/**
 * Everything that talks to Paddle about a *factory's* subscription. (Pushing
 * the price list itself into Paddle lives in plan.service.ts.)
 *
 * The flow this backs is: a visitor registers (factory row created as
 * `pending`, subdomain reserved) -> we open a Paddle transaction and hand its
 * id to the browser -> Paddle.js opens the checkout overlay -> Paddle calls our
 * webhook -> the factory flips to `active` and can sign in.
 *
 * Unlike a Stripe Checkout redirect, Paddle's checkout is rendered by Paddle.js
 * in the page. We therefore return a transaction id, not a URL, and the
 * frontend opens the overlay with it.
 *
 * The **webhook**, not the browser, is what grants access. A user can close the
 * overlay before it reports success, and anything the browser sends can be
 * forged; a signed webhook cannot.
 */

export { BillingDisabledError } from "../config/paddle";

/**
 * Maps a Paddle subscription status onto ours.
 *
 * `trialing` counts as active so adding a trial later needs no change here.
 * `paused` means Paddle has stopped collecting, which for access purposes is
 * the same as not having paid.
 */
function statusFromPaddle(status: Subscription["status"]): subscriptions.FactoryStatus {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
      return "canceled";
    case "paused":
    default:
      return "pending";
  }
}

async function getOrCreateCustomer(factoryId: string): Promise<string> {
  const existing = await subscriptions.getSubscription(factoryId);
  if (!existing) throw new Error("Factory not found");
  if (existing.paddleCustomerId) return existing.paddleCustomerId;

  const factory = await pool.query(
    "SELECT name, email, username FROM factories WHERE id = $1",
    [factoryId]
  );
  const row = factory.rows[0];
  if (!row) throw new Error("Factory not found");

  const client = paddle();
  let customerId: string;

  try {
    const customer = await client.customers.create({
      email: row.email,
      name: row.name,
      customData: { factory_id: factoryId, username: row.username ?? "" },
    });
    customerId = customer.id;
  } catch (err) {
    // Paddle rejects a duplicate email outright, which happens whenever someone
    // re-registers or we created the customer on an earlier attempt. Adopt the
    // existing record instead of dead-ending the signup.
    const existingCustomer = await findCustomerByEmail(row.email);
    if (!existingCustomer) throw err;
    customerId = existingCustomer;
  }

  await subscriptions.setPaddleCustomer(factoryId, customerId);
  return customerId;
}

async function findCustomerByEmail(email: string): Promise<string | null> {
  const page = paddle().customers.list({ email: [email] });
  for await (const customer of page) {
    return customer.id;
  }
  return null;
}

export interface CheckoutSessionResult {
  /** Paddle.js opens the overlay with this. There is no redirect URL. */
  transactionId: string;
}

/**
 * Opens a Paddle transaction for a factory's subscription.
 *
 * `factory_id` rides along in the transaction's custom data so the webhook can
 * match a payment back to the right account without trusting the browser.
 */
export async function createCheckoutSession(
  factoryId: string,
  planCode: string,
  interval: BillingInterval
): Promise<CheckoutSessionResult> {
  const priceId = await planService.paddlePriceIdFor(planCode, interval);
  const customerId = await getOrCreateCustomer(factoryId);

  const transaction = await paddle().transactions.create({
    items: [{ priceId, quantity: 1 }],
    customerId,
    customData: { factory_id: factoryId, plan: planCode, interval },
    checkout: { url: `${env.frontendUrl}/register/success` },
  });

  return { transactionId: transaction.id };
}

/**
 * A Paddle-hosted page where a customer updates their payment method or
 * cancels. Scoped to their subscription when they have one.
 */
export async function createPortalSession(factoryId: string): Promise<string> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current?.paddleCustomerId) {
    throw new Error("This factory has no billing account yet");
  }

  const session = await paddle().customerPortalSessions.create(
    current.paddleCustomerId,
    current.paddleSubscriptionId ? [current.paddleSubscriptionId] : []
  );

  return session.urls.general.overview;
}

/**
 * Switches an existing subscription to a different plan or interval, with
 * Paddle prorating the difference. A factory with no subscription yet goes
 * through checkout instead.
 */
export async function changePlan(
  factoryId: string,
  planCode: string,
  interval: BillingInterval
): Promise<{ changed: true } | CheckoutSessionResult> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current) throw new Error("Factory not found");

  if (!current.paddleSubscriptionId) {
    return createCheckoutSession(factoryId, planCode, interval);
  }

  const priceId = await planService.paddlePriceIdFor(planCode, interval);

  await paddle().subscriptions.update(current.paddleSubscriptionId, {
    items: [{ priceId, quantity: 1 }],
    prorationBillingMode: "prorated_immediately",
    customData: { factory_id: factoryId, plan: planCode, interval },
  });

  // Reflect it immediately so the dashboard doesn't show a stale plan while we
  // wait for `subscription.updated` to arrive.
  await subscriptions.applyPlan(factoryId, planCode, interval);
  return { changed: true };
}

/** Flags the subscription to stop at the end of the paid period. */
export async function cancelAtPeriodEnd(
  factoryId: string,
  cancel: boolean
): Promise<void> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current?.paddleSubscriptionId) {
    throw new Error("This factory has no active subscription");
  }

  const client = paddle();

  if (cancel) {
    await client.subscriptions.cancel(current.paddleSubscriptionId, {
      effectiveFrom: "next_billing_period",
    });
  } else {
    // Clearing a scheduled cancellation is what Paddle calls removing the
    // scheduled change; there is no "uncancel" verb.
    await client.subscriptions.update(current.paddleSubscriptionId, {
      scheduledChange: null,
    });
  }

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
  if (!current?.paddleCustomerId) return [];

  const client = paddle();
  const page = client.transactions.list({
    customerId: [current.paddleCustomerId],
    perPage: 24,
  });

  const invoices: InvoiceSummary[] = [];
  for await (const transaction of page) {
    invoices.push({
      id: transaction.id,
      number: transaction.invoiceNumber ?? null,
      amountPaid: fromMinorUnits(transaction.details?.totals?.grandTotal),
      currency: transaction.currencyCode ?? "USD",
      status: transaction.status ?? null,
      createdAt: transaction.billedAt ?? transaction.createdAt,
      // Paddle serves invoice PDFs through a short-lived signed link, fetched
      // on demand rather than stored.
      invoiceUrl: null,
      pdfUrl: null,
    });
    if (invoices.length >= 24) break;
  }

  return invoices;
}

/** A fresh, short-lived link to one invoice PDF. */
export async function getInvoicePdfUrl(
  factoryId: string,
  transactionId: string
): Promise<string> {
  const current = await subscriptions.getSubscription(factoryId);
  if (!current?.paddleCustomerId) throw new Error("No billing account");

  const transaction = await paddle().transactions.get(transactionId);
  // Scope the lookup to this factory: a transaction id alone must not expose
  // another tenant's invoice.
  if (transaction.customerId !== current.paddleCustomerId) {
    throw new Error("Invoice not found");
  }

  const pdf = await paddle().transactions.getInvoicePDF(transactionId);
  return pdf.url;
}

/**
 * Reads a transaction so the success page can confirm the payment landed -- and,
 * if the webhook hasn't arrived yet, activate the factory from the transaction
 * itself. The id is re-fetched from Paddle rather than trusted from the query
 * string, so this is a safe fallback rather than a bypass.
 */
export async function resolveCheckoutSession(transactionId: string): Promise<{
  status: string;
  paid: boolean;
  factory: { id: string; name: string; username: string | null; email: string } | null;
  plan: string | null;
  interval: BillingInterval | null;
}> {
  const transaction = await paddle().transactions.get(transactionId);

  const custom = (transaction.customData ?? {}) as Record<string, string>;
  const factoryId = custom.factory_id ?? null;
  const paid = transaction.status === "completed" || transaction.status === "paid";

  if (!factoryId) {
    return {
      status: transaction.status,
      paid,
      factory: null,
      plan: null,
      interval: null,
    };
  }

  if (paid) await activateFromTransaction(transaction, factoryId);

  const result = await pool.query(
    "SELECT id, name, username, email, plan, billing_interval FROM factories WHERE id = $1",
    [factoryId]
  );
  const row = result.rows[0];

  return {
    status: transaction.status,
    paid,
    factory: row
      ? { id: row.id, name: row.name, username: row.username, email: row.email }
      : null,
    plan: row?.plan ?? null,
    interval: (row?.billing_interval as BillingInterval) ?? null,
  };
}

async function activateFromTransaction(
  transaction: Transaction,
  factoryId: string
): Promise<void> {
  const custom = (transaction.customData ?? {}) as Record<string, string>;
  const planCode = custom.plan || "starter";
  const interval = (custom.interval as BillingInterval) || "monthly";

  let periodEnd: Date | null = null;
  let cancelAtEnd = false;

  if (transaction.subscriptionId) {
    const sub = await paddle().subscriptions.get(transaction.subscriptionId);
    periodEnd = sub.currentBillingPeriod?.endsAt
      ? new Date(sub.currentBillingPeriod.endsAt)
      : null;
    cancelAtEnd = sub.scheduledChange?.action === "cancel";
  }

  await subscriptions.applyPlan(factoryId, planCode, interval, {
    status: "active",
    paddleCustomerId: transaction.customerId ?? null,
    paddleSubscriptionId: transaction.subscriptionId ?? null,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: cancelAtEnd,
  });
}

// --- Webhooks ----------------------------------------------------------------

/**
 * Verifies Paddle's signature and parses the event.
 *
 * `rawBody` must be the exact bytes Paddle signed -- see the raw body parser
 * mounted ahead of express.json() in index.ts.
 */
export async function constructWebhookEvent(
  rawBody: Buffer,
  signature: string
): Promise<EventEntity> {
  if (!env.paddle.webhookSecret) {
    throw new Error("PADDLE_WEBHOOK_SECRET is not set");
  }
  const event = await paddle().webhooks.unmarshal(
    rawBody.toString("utf8"),
    env.paddle.webhookSecret,
    signature
  );
  if (!event) throw new Error("Invalid Paddle signature");
  return event;
}

/**
 * Records the event id first and bails if we've seen it before. Paddle delivers
 * at least once and retries on failure, so without this a retry could re-apply
 * a plan change the customer has since reversed.
 */
async function claimEvent(
  eventId: string,
  type: string,
  factoryId: string | null,
  payload: unknown
): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO subscription_events (provider_event_id, type, factory_id, payload)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (provider_event_id) DO NOTHING
     RETURNING id`,
    [eventId, type, factoryId, JSON.stringify(payload)]
  );
  return (result.rowCount ?? 0) > 0;
}

async function factoryIdForSubscription(sub: Subscription): Promise<string | null> {
  const custom = (sub.customData ?? {}) as Record<string, string>;
  if (custom.factory_id) return custom.factory_id;

  const bySubscription = await subscriptions.findByPaddleSubscription(sub.id);
  if (bySubscription) return bySubscription.factoryId;

  const byCustomer = await subscriptions.findByPaddleCustomer(sub.customerId);
  return byCustomer?.factoryId ?? null;
}

async function syncSubscription(sub: Subscription): Promise<void> {
  const factoryId = await factoryIdForSubscription(sub);
  if (!factoryId) {
    console.warn(`[billing] No factory matches Paddle subscription ${sub.id}`);
    return;
  }

  const priceId = sub.items?.[0]?.price?.id ?? "";
  const resolved = priceId ? await planService.findPlanByPaddlePriceId(priceId) : null;

  const custom = (sub.customData ?? {}) as Record<string, string>;

  // An unrecognised price means the subscription points at something this
  // catalog doesn't know -- an archived price, or one made in the Paddle
  // dashboard. Keep the stored plan rather than guessing, but still sync status
  // and dates so access and renewal stay correct.
  const planCode = resolved?.plan.code ?? custom.plan ?? null;
  const interval = resolved?.interval ?? (custom.interval as BillingInterval) ?? null;

  const status = statusFromPaddle(sub.status);
  const periodEnd = sub.currentBillingPeriod?.endsAt
    ? new Date(sub.currentBillingPeriod.endsAt)
    : null;
  const cancelAtEnd = sub.scheduledChange?.action === "cancel";

  const planExists = planCode ? Boolean(await planService.findPlan(planCode)) : false;

  if (planCode && interval && planExists) {
    await subscriptions.applyPlan(factoryId, planCode, interval, {
      status,
      paddleCustomerId: sub.customerId,
      paddleSubscriptionId: sub.id,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: cancelAtEnd,
    });
  } else {
    await pool.query(
      `UPDATE factories SET
         status = $2,
         paddle_subscription_id = $3,
         current_period_end = COALESCE($4, current_period_end),
         cancel_at_period_end = $5
       WHERE id = $1`,
      [factoryId, status, sub.id, periodEnd, cancelAtEnd]
    );
  }
}

export async function handleWebhookEvent(event: EventEntity): Promise<void> {
  const type = event.eventType as string;

  switch (type) {
    case "transaction.completed":
    case "transaction.paid": {
      const transaction = event.data as Transaction;
      const custom = (transaction.customData ?? {}) as Record<string, string>;
      const factoryId = custom.factory_id ?? null;

      if (!(await claimEvent(event.eventId, type, factoryId, transaction))) return;
      if (!factoryId) {
        console.warn(`[billing] ${type} with no factory_id: ${transaction.id}`);
        return;
      }
      await activateFromTransaction(transaction, factoryId);
      console.log(`[billing] Factory ${factoryId} activated from ${transaction.id}`);
      return;
    }

    case "subscription.created":
    case "subscription.updated":
    case "subscription.activated":
    case "subscription.canceled":
    case "subscription.paused":
    case "subscription.resumed": {
      const sub = event.data as Subscription;
      const factoryId = await factoryIdForSubscription(sub);
      if (!(await claimEvent(event.eventId, type, factoryId, sub))) return;
      await syncSubscription(sub);
      return;
    }

    case "transaction.payment_failed": {
      const transaction = event.data as Transaction;
      const factory = transaction.customerId
        ? await subscriptions.findByPaddleCustomer(transaction.customerId)
        : null;

      if (!(await claimEvent(event.eventId, type, factory?.factoryId ?? null, transaction)))
        return;
      if (factory && factory.status === "active") {
        await subscriptions.setStatus(factory.factoryId, "past_due");
        console.log(`[billing] Factory ${factory.factoryId} marked past_due`);
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
    hasSubscription: Boolean(overview.subscription.paddleSubscriptionId),
    billingEnabled,
    usage: overview.usage,
    channels: overview.channels,
    invoices,
  };
}
