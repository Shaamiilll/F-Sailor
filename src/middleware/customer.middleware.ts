import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth.middleware";

/**
 * Gate for storefront buyers. Pairs with the existing `authMiddleware`, which
 * does the signature check.
 *
 * Customer tokens carry role "customer" and cannot pass `factoryMiddleware`
 * (which demands role "factory"); factory/admin tokens cannot pass this one.
 * Same JWT secret, mutually exclusive roles.
 */
export function customerMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (!req.user || req.user.role !== "customer" || !req.user.leadId || !req.user.factoryId) {
    res.status(403).json({ error: "Customer access required" });
    return;
  }
  next();
}
