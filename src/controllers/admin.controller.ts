import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { isBillingInterval } from "../config/plans";
import * as adminService from "../services/admin.service";
import * as planService from "../services/plan.service";
import {
  ConflictError,
  ValidationError,
} from "../services/registration.service";
import { isFactoryStatus } from "../services/subscription.service";

export async function listFactories(_req: AuthRequest, res: Response) {
  try {
    res.json(await adminService.listFactories());
  } catch (err) {
    fail(res, err as Error);
  }
}

/**
 * Creates a factory directly, with no payment taken. The plan is still required
 * -- it's what determines the account's channel and mockup limits.
 */
export async function createFactory(req: AuthRequest, res: Response) {
  try {
    const { name, type, country, email, phone, password, username, plan, interval } =
      req.body ?? {};

    if (!name || !email || !password || !username) {
      res
        .status(400)
        .json({ error: "Name, email, password and subdomain are required" });
      return;
    }
    if (!plan || typeof plan !== "string") {
      res.status(400).json({ error: "Choose a plan for this factory" });
      return;
    }
    if (interval !== undefined && !isBillingInterval(interval)) {
      res.status(400).json({ error: "Billing interval must be monthly or annual" });
      return;
    }

    const result = await adminService.createFactory({
      name,
      type,
      country,
      email,
      phone,
      password,
      username,
      plan,
      interval,
    });

    res.status(201).json(result);
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function updateFactoryPlan(req: AuthRequest, res: Response) {
  try {
    const { plan, interval } = req.body ?? {};
    if (!plan || typeof plan !== "string") {
      res.status(400).json({ error: "Choose a plan" });
      return;
    }
    if (interval !== undefined && !isBillingInterval(interval)) {
      res.status(400).json({ error: "Billing interval must be monthly or annual" });
      return;
    }

    res.json(await adminService.setFactoryPlan(String(req.params.id), plan, interval));
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function updateFactoryStatus(req: AuthRequest, res: Response) {
  try {
    const { status } = req.body ?? {};
    if (!isFactoryStatus(status)) {
      res.status(400).json({
        error: "Status must be one of: pending, active, past_due, canceled, suspended",
      });
      return;
    }

    res.json(await adminService.setFactoryStatus(String(req.params.id), status));
  } catch (err) {
    fail(res, err as Error);
  }
}

function fail(res: Response, err: Error) {
  if (err instanceof ValidationError || err instanceof planService.PlanValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof planService.PlanNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof ConflictError) {
    res.status(409).json({ error: err.message });
    return;
  }
  const message = err.message || "";
  if (message.includes("duplicate") || message.includes("unique")) {
    res.status(409).json({ error: "That email or subdomain is already taken" });
    return;
  }
  if (message === "Factory not found") {
    res.status(404).json({ error: message });
    return;
  }
  console.error("[admin]", err);
  res.status(500).json({ error: message });
}
