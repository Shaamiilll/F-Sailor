import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as mockupService from "../services/mockup.service";

export async function createMockup(req: ChatRequest, res: Response) {
  try {
    const { productId, leadId, logoUrl } = req.body;

    if (!productId || !logoUrl) {
      res.status(400).json({ error: "productId and logoUrl are required" });
      return;
    }

    const mockup = await mockupService.createMockup(req.factoryId!, {
      productId,
      leadId,
      logoUrl,
    });

    res.status(201).json(mockup);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
