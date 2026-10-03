import { Router } from "express";
import * as dashboardController from "../controllers/dashboard.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";
import { requireActiveSubscription } from "../middleware/subscription.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware, requireActiveSubscription);

router.get("/stats", dashboardController.getStats);
router.get("/analytics", dashboardController.getAnalytics);

export default router;
