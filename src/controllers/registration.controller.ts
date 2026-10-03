import { Request, Response } from "express";
import { isBillingInterval } from "../config/plans";
import { BillingDisabledError } from "../config/stripe";
import * as planService from "../services/plan.service";
import * as registration from "../services/registration.service";

/** The live pricing catalog, for the marketing site and the signup form. */
export async function listPlans(_req: Request, res: Response) {
  try {
    res.json(await planService.listPublicPlans());
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function checkUsername(req: Request, res: Response) {
  try {
    const result = await registration.checkUsername(req.query.username);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function register(req: Request, res: Response) {
  try {
    const {
      factoryName,
      factoryType,
      country,
      phone,
      username,
      email,
      password,
      plan,
      interval,
    } = req.body ?? {};

    if (!plan || typeof plan !== "string") {
      res.status(400).json({ error: "Choose a plan" });
      return;
    }
    if (!isBillingInterval(interval)) {
      res.status(400).json({ error: "Billing interval must be monthly or annual" });
      return;
    }

    const result = await registration.register({
      factoryName,
      factoryType,
      country,
      phone,
      username,
      email,
      password,
      plan,
      interval,
    });

    res.status(201).json(result);
  } catch (err) {
    respondWithError(res, err as Error);
  }
}

/** Restarts checkout for an account that registered but never completed payment. */
export async function resumeCheckout(req: Request, res: Response) {
  try {
    const { factoryId, plan, interval } = req.body ?? {};
    if (!factoryId) {
      res.status(400).json({ error: "factoryId is required" });
      return;
    }
    if (interval !== undefined && !isBillingInterval(interval)) {
      res.status(400).json({ error: "Billing interval must be monthly or annual" });
      return;
    }

    const url = await registration.resumeCheckout(factoryId, plan, interval);
    res.json({ checkoutUrl: url });
  } catch (err) {
    respondWithError(res, err as Error);
  }
}

function respondWithError(res: Response, err: Error) {
  if (
    err instanceof registration.ValidationError ||
    err instanceof planService.PlanValidationError
  ) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof planService.PlanNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof registration.ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  if (err instanceof BillingDisabledError) {
    res.status(503).json({ error: err.message, code: err.code });
    return;
  }
  console.error("[register]", err);
  res.status(500).json({ error: err.message });
}
