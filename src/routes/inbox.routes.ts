import { Router } from "express";
import * as inboxController from "../controllers/inbox.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";
import { requireActiveSubscription } from "../middleware/subscription.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware, requireActiveSubscription);

router.get("/conversations", inboxController.listConversations);
router.get("/conversations/:id/messages", inboxController.getConversationMessages);
router.get("/mockups", inboxController.listMockups);

export default router;
