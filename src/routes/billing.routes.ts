import { Router } from "express";
import * as billingController from "../controllers/billing.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

/**
 * Note what is deliberately NOT behind `requireActiveSubscription`: these are
 * the endpoints a factory with a lapsed or unpaid subscription needs in order
 * to start paying again. Gating them would lock people out of the one page
 * that could let them back in.
 */
router.use(authMiddleware, factoryMiddleware);

router.get("/", billingController.overview);
router.post("/checkout", billingController.checkout);
router.post("/portal", billingController.portal);
router.post("/cancel", billingController.setCancelAtPeriodEnd);
router.get("/invoices/:id/pdf", billingController.invoicePdf);

router.get("/channels", billingController.listChannels);
router.patch("/channels/:channel", billingController.setChannel);

export default router;
