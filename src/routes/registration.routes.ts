import { Router } from "express";
import * as registrationController from "../controllers/registration.controller";
import * as billingController from "../controllers/billing.controller";

/** Everything a visitor can reach before they have an account. */
const router = Router();

router.get("/plans", registrationController.listPlans);
router.get("/username-available", registrationController.checkUsername);
router.post("/register", registrationController.register);
router.post("/resume-checkout", registrationController.resumeCheckout);
router.get("/checkout-session", billingController.checkoutSession);

export default router;
