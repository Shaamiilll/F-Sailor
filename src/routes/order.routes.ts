import { Router } from "express";
import * as orderController from "../controllers/order.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/", orderController.listOrders);
router.get("/:id", orderController.getOrder);
router.patch("/:id", orderController.updateOrder);
router.patch("/:id/status", orderController.updateOrderStatus);

export default router;
