import { Router } from "express";
import * as adminController from "../controllers/admin.controller";
import * as planController from "../controllers/plan.controller";
import { authMiddleware, adminMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/factories", adminController.listFactories);
router.post("/factories", adminController.createFactory);
router.patch("/factories/:id/plan", adminController.updateFactoryPlan);
router.patch("/factories/:id/status", adminController.updateFactoryStatus);

// The price list. Writes here sync straight through to Stripe.
router.get("/plans", planController.list);
router.post("/plans", planController.create);
router.get("/plans/:code", planController.get);
router.patch("/plans/:code", planController.update);
router.delete("/plans/:code", planController.remove);
router.post("/plans/:code/sync", planController.sync);

export default router;
