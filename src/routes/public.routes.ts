import { Router } from "express";
import * as publicController from "../controllers/public.controller";

const router = Router();

// Public storefront endpoints -- no auth, scoped by factory username (subdomain).
router.get("/factories/:username", publicController.getFactoryByUsername);
router.get("/factories/:username/products", publicController.getFactoryProducts);

export default router;
