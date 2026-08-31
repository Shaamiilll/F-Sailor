import { Router } from "express";
import * as productController from "../controllers/product.controller";
import {
  authMiddleware,
  factoryMiddleware,
} from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/", productController.listProducts);
router.get("/:id", productController.getProduct);
router.post("/", productController.createProduct);
router.put("/:id", productController.updateProduct);
router.delete("/:id", productController.deleteProduct);

export default router;
