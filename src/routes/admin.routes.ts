import { Router } from "express";
import * as adminController from "../controllers/admin.controller";
import { authMiddleware, adminMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, adminMiddleware);

router.get("/factories", adminController.listFactories);
router.post("/factories", adminController.createFactory);

export default router;
