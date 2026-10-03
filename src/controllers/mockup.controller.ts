
import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as mockupService from "../services/mockup.service";
import * as subscriptions from "../services/subscription.service";

export async function createMockup(req: ChatRequest, res: Response) {
  try {
    const { product_id, logo_url, lead_id } = req.body;

    if (!product_id || !logo_url) {
      return res.status(400).json({ error: "product_id and logo_url are required" });
    }

    // The plan's monthly allowance is enforced here rather than only on the
    // /quota endpoint -- the chatbot is free to skip that check, and generating
    // a mockup is the expensive part.
    const quota = await subscriptions.checkMockupQuota(req.factoryId!);
    if (!quota.allowed) {
      return res.status(403).json({
        error: `Monthly mockup limit reached (${quota.used}/${quota.limit}). Upgrade your plan for a higher allowance.`,
        code: "QUOTA_EXCEEDED",
        quota,
      });
    }

    const mockupUrl = await mockupService.generateProductMockup({
      factoryId: req.factoryId!,
      productId: product_id,
      logoUrl: logo_url,
      leadId: lead_id,
    });

    res.status(201).json({
      success: true,
      mockupUrl,
      quota: {
        used: quota.used + 1,
        limit: quota.limit,
        remaining: Math.max(0, quota.remaining - 1),
      },
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
