import { Router } from "express";
import * as whatsappController from "../controllers/whatsapp.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";
import { requireActiveSubscription } from "../middleware/subscription.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware, requireActiveSubscription);

router.get("/config", whatsappController.getConfig);
router.patch("/config", whatsappController.updateConfig);
router.post("/verify", whatsappController.verify);
router.post("/disconnect", whatsappController.disconnect);
router.post("/test", whatsappController.sendTest);
router.patch("/conversations/:id/handover", whatsappController.setHandover);

export default router;
