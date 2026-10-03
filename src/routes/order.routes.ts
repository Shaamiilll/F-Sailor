import { Router } from "express";
import * as orderController from "../controllers/order.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";
import { requireActiveSubscription } from "../middleware/subscription.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware, requireActiveSubscription);

router.get("/", orderController.listOrders);
router.get("/:id", orderController.getOrder);
router.patch("/:id", orderController.updateOrder);
router.patch("/:id/status", orderController.updateOrderStatus);

export default router;
