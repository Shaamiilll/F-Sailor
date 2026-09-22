
import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as mockupService from "../services/mockup.service";

export async function createMockup(req: ChatRequest, res: Response) {
  try {
    const { product_id, logo_url, lead_id } = req.body;

    if (!product_id || !logo_url) {
      return res.status(400).json({ error: "product_id and logo_url are required" });
    }

    const mockupUrl = await mockupService.generateProductMockup({
      factoryId: req.factoryId!,
      productId: product_id,
      logoUrl: logo_url,
      leadId: lead_id,
    });

    res.status(201).json({ success: true, mockupUrl });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}