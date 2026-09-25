import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as inbox from "../services/inbox.service";

export async function listConversations(req: AuthRequest, res: Response) {
  try {
    res.json(await inbox.listConversations(req.user!.factoryId!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getConversationMessages(req: AuthRequest, res: Response) {
  try {
    const messages = await inbox.getConversationMessages(
      req.user!.factoryId!,
      req.params.id as string
    );
    if (!messages) {
      res.status(404).json({ error: "Conversation not found" });
      return;
    }
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function listMockups(req: AuthRequest, res: Response) {
  try {
    res.json(await inbox.listMockups(req.user!.factoryId!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
