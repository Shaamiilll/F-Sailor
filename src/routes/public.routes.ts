import { Router } from "express";
import * as publicController from "../controllers/public.controller";
import { authMiddleware } from "../middleware/auth.middleware";
import { customerMiddleware } from "../middleware/customer.middleware";

const router = Router();

// --- Open storefront: no auth, scoped by factory username (subdomain) --------
router.get("/factories/:username", publicController.getFactoryByUsername);
router.get("/factories/:username/products", publicController.getFactoryProducts);
router.get("/factories/:username/products/:id", publicController.getFactoryProduct);
router.post("/factories/:username/quote-preview", publicController.previewQuote);

// --- Customer accounts, scoped per factory ----------------------------------
router.post("/factories/:username/customers/register", publicController.registerCustomer);
router.post("/factories/:username/customers/login", publicController.loginCustomer);

// --- Customer portal: requires a customer JWT -------------------------------
// authMiddleware verifies the signature; customerMiddleware rejects factory and
// admin tokens, so these routes can only ever be reached by a buyer.
const portal = Router();
portal.use(authMiddleware, customerMiddleware);

portal.get("/", publicController.getMe);
portal.post("/quote-requests", publicController.submitQuoteRequest);
portal.get("/quotations", publicController.listMyQuotations);
portal.get("/quotations/:id", publicController.getMyQuotation);
portal.post("/quotations/:id/pdf", publicController.getMyQuotationPdf);
portal.get("/orders", publicController.listMyOrders);
portal.get("/orders/:id", publicController.getMyOrderTimeline);

router.use("/me", portal);

export default router;
