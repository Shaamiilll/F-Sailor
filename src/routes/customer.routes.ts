import { Router } from "express";
import * as customerController from "../controllers/customer.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/", customerController.listCustomers);
router.get("/:id", customerController.getCustomer);
router.patch("/:id", customerController.updateCustomer);

export default router;
