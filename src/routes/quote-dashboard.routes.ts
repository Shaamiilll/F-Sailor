import { Router } from "express";
import * as quoteDashboardController from "../controllers/quote-dashboard.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/", quoteDashboardController.listQuotations);
router.post("/:id/approve", quoteDashboardController.approveQuotation);
router.post("/:id/reject", quoteDashboardController.rejectQuotation);

export default router;