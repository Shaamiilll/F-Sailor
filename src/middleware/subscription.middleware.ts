import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";
import * as subscriptions from "../services/subscription.service";

/**
 * Gates the factory dashboard on a usable subscription.
 *
 * Runs after `factoryMiddleware`, so `req.user.factoryId` is already known to
 * exist. The reply carries a machine-readable `code` so the frontend can route
 * to checkout rather than just showing an error string.
 */
export async function requireActiveSubscription(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const factoryId = req.user?.factoryId;
  if (!factoryId) {
    res.status(403).json({ error: "Factory access required" });
    return;
  }

  try {
    const subscription = await subscriptions.getSubscription(factoryId);
    if (!subscription) {
      res.status(404).json({ error: "Factory not found" });
      return;
    }

    if (subscriptions.isUsable(subscription.status)) {
      next();
      return;
    }

    const reasons: Record<string, { code: string; error: string }> = {
      pending: {
        code: "PAYMENT_REQUIRED",
        error: "Your subscription isn't active yet. Complete checkout to start using KayanFlow.",
      },
      canceled: {
        code: "SUBSCRIPTION_CANCELED",
        error: "Your subscription has ended. Resubscribe to regain access to your dashboard.",
      },
      suspended: {
        code: "SUSPENDED",
        error: "This account has been suspended. Contact support for help.",
      },
    };

    const reason = reasons[subscription.status] ?? {
      code: "SUBSCRIPTION_INACTIVE",
      error: "Your subscription is not active.",
    };

    // 402 rather than 403: the block is about payment, not permissions, and the
    // frontend keeps the session instead of logging the user out.
    res.status(402).json({ ...reason, status: subscription.status });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * Refuses a request once the factory has used up its monthly AI mockup
 * allowance. Used on the chatbot's mockup endpoint, which authenticates by
 * `x-factory-id` rather than a JWT, so the id is passed in explicitly.
 */
export async function assertMockupQuota(factoryId: string): Promise<void> {
  const quota = await subscriptions.checkMockupQuota(factoryId);
  if (!quota.allowed) {
    const err = new Error(
      `Monthly mockup limit reached (${quota.used}/${quota.limit}). Upgrade your plan for a higher allowance.`
    ) as Error & { code?: string; quota?: typeof quota };
    err.code = "QUOTA_EXCEEDED";
    err.quota = quota;
    throw err;
  }
}
