import { Router } from "express";
import * as dashboardController from "../controllers/dashboard.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/stats", dashboardController.getStats);
router.get("/analytics", dashboardController.getAnalytics);

export default router;
