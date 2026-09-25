import { Router } from "express";
import * as settingsController from "../controllers/settings.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/", settingsController.getSettings);
router.patch("/factory", settingsController.updateFactory);
router.post("/discount-tiers", settingsController.createDiscountTier);
router.delete("/discount-tiers/:id", settingsController.deleteDiscountTier);
router.post("/shipping-rates", settingsController.createShippingRate);
router.delete("/shipping-rates/:id", settingsController.deleteShippingRate);

export default router;
