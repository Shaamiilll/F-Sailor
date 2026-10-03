import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as planService from "../services/plan.service";

/**
 * Admin-side CRUD for the price list. Every write syncs the plan into Paddle so
 * the catalog and the payment processor stay in step without a deploy.
 */

export async function list(_req: AuthRequest, res: Response) {
  try {
    res.json(await planService.listPlans());
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function get(req: AuthRequest, res: Response) {
  try {
    res.json(await planService.requirePlan(String(req.params.code)));
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function create(req: AuthRequest, res: Response) {
  try {
    const plan = await planService.createPlan(req.body ?? {});
    res.status(201).json(plan);
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function update(req: AuthRequest, res: Response) {
  try {
    const plan = await planService.updatePlan(String(req.params.code), req.body ?? {});
    res.json(plan);
  } catch (err) {
    fail(res, err as Error);
  }
}

export async function remove(req: AuthRequest, res: Response) {
  try {
    await planService.deletePlan(String(req.params.code));
    res.json({ success: true });
  } catch (err) {
    fail(res, err as Error);
  }
}

/** Re-pushes a plan into Paddle, for when an earlier sync failed. */
export async function sync(req: AuthRequest, res: Response) {
  try {
    const plan = await planService.requirePlan(String(req.params.code));
    res.json(await planService.syncPlanToPaddle(plan));
  } catch (err) {
    fail(res, err as Error);
  }
}

function fail(res: Response, err: Error) {
  if (err instanceof planService.PlanNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  if (err instanceof planService.PlanValidationError) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (err instanceof planService.PlanInUseError) {
    res.status(409).json({ error: err.message, code: err.code });
    return;
  }
  console.error("[plans]", err);
  res.status(500).json({ error: err.message });
}
