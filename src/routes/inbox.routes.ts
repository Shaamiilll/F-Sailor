import { Router } from "express";
import * as inboxController from "../controllers/inbox.controller";
import { authMiddleware, factoryMiddleware } from "../middleware/auth.middleware";

const router = Router();

router.use(authMiddleware, factoryMiddleware);

router.get("/conversations", inboxController.listConversations);
router.get("/conversations/:id/messages", inboxController.getConversationMessages);
router.get("/mockups", inboxController.listMockups);

export default router;
