import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { isBillingInterval } from "../config/plans";
import { BillingDisabledError } from "../config/paddle";
import * as billing from "../services/billing.service";
import * as planService from "../services/plan.service";
import * as subscriptions from "../services/subscription.service";

/** Plan, price, status, usage, channels and invoices for the billing page. */
export async function overview(req: AuthRequest, res: Response) {
  try {
    const overview = await billing.getBillingOverview(req.user!.factoryId!);
    res.json(overview);
  } catch (err) {
    fail(res, err as Error);
  }
}

/** Opens Checkout, or switches an existing subscription in place. */
export async function checkout(req: AuthRequest, res: Response) {
  try {
    const { plan, interval } = req.body ?? {};
    if (!plan || typeof plan !== "string") {
      res.status(400).json({ error: "Choose a plan" });
      return;
    }
    if (!isBillingInterval(interval)) {
      res.status(400).json({ error: "Billing interval must be monthly or annual" });
      return;
    }

    const result = await billing.changePlan(req.user!.factoryId!, plan, interval);
    res.json(result);
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function portal(req: AuthRequest, res: Response) {
  try {
    const url = await billing.createPortalSession(req.user!.factoryId!);
    res.json({ url });
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function setCancelAtPeriodEnd(req: AuthRequest, res: Response) {
  try {
    const cancel = Boolean(req.body?.cancel);
    await billing.cancelAtPeriodEnd(req.user!.factoryId!, cancel);
    res.json({ cancelAtPeriodEnd: cancel });
  } catch (err) {
    fail(res, err as Error);
  }
}

/**
 * Public: the success page calls this with the Checkout session id to confirm
 * the payment landed and learn which subdomain to send the new customer to.
 */
export async function checkoutSession(req: Request, res: Response) {
  try {
    // Paddle appends `_ptxn` to the success URL; accept the explicit names too
    // so the endpoint is callable directly.
    const transactionId = String(
      req.query._ptxn ?? req.query.transaction_id ?? req.query.session_id ?? ""
    );
    if (!transactionId) {
      res.status(400).json({ error: "A transaction id is required" });
      return;
    }
    res.json(await billing.resolveCheckoutSession(transactionId));
  } catch (err) {
    fail(res, err as Error);
  }
}

/** A short-lived link to one invoice PDF, scoped to the signed-in factory. */
export async function invoicePdf(req: AuthRequest, res: Response) {
  try {
    const url = await billing.getInvoicePdfUrl(
      req.user!.factoryId!,
      String(req.params.id)
    );
    res.json({ url });
  } catch (err) {
    fail(res, err as Error);
  }
}

// --- Channels ----------------------------------------------------------------

export async function listChannels(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const [channels, subscription] = await Promise.all([
      subscriptions.listChannels(factoryId),
      subscriptions.getSubscription(factoryId),
    ]);
    res.json({
      channels,
      limit: subscription?.channelLimit ?? 1,
      available: subscriptions.CHANNEL_KEYS,
    });
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function setChannel(req: AuthRequest, res: Response) {
  try {
    const channel = req.params.channel;
    if (!subscriptions.isChannelKey(channel)) {
      res.status(400).json({
        error: `Unknown channel. Expected one of: ${subscriptions.CHANNEL_KEYS.join(", ")}`,
      });
      return;
    }

    const updated = await subscriptions.setChannelEnabled(
      req.user!.factoryId!,
      channel,
      Boolean(req.body?.enabled),
      req.body?.config
    );
    res.json(updated);
  } catch (err) {
    fail(res, err as Error);
  }
}

/**
 * Paddle's webhook. Mounted with a raw body parser so the signature can be
 * verified -- express.json() would have already reparsed and reserialized the
 * payload, which changes the bytes and breaks the signature.
 */
export async function webhook(req: Request, res: Response) {
  const signature = req.header("paddle-signature");
  if (!signature) {
    res.status(400).json({ error: "Missing paddle-signature header" });
    return;
  }

  let event;
  try {
    event = await billing.constructWebhookEvent(req.body as Buffer, signature);
  } catch (err) {
    console.error("[billing] Webhook signature verification failed:", err);
    res.status(400).json({ error: `Webhook Error: ${(err as Error).message}` });
    return;
  }

  try {
    await billing.handleWebhookEvent(event);
    res.json({ received: true });
  } catch (err) {
    // A non-2xx makes Paddle retry, which is what we want for a transient
    // failure -- the event ledger keeps the retry from double-applying.
    console.error(`[billing] Failed to handle ${event.eventType}:`, err);
    res.status(500).json({ error: (err as Error).message });
  }
}

function fail(res: Response, err: Error) {
  if (err instanceof BillingDisabledError) {
    res.status(503).json({ error: err.message, code: "BILLING_DISABLED" });
    return;
  }
  if (err instanceof planService.PlanNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (
    err instanceof planService.PlanValidationError ||
    err instanceof subscriptions.PlanLimitError
  ) {
    res.status(400).json({ error: err.message, code: (err as any).code });
    return;
  }
  console.error("[billing]", err);
  res.status(500).json({ error: err.message });
}
