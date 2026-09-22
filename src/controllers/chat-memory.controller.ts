import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as memoryService from "../services/chat-memory.service";
import { pool } from "../config/db";

// GET /chat/history/:userId
export async function getHistory(req: ChatRequest, res: Response) {
  try {
    const { userId } = req.params;
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 20;

    const history = await memoryService.getChatHistory(
      req.factoryId!,
      userId,
      limit
    );

    res.json({
      factory_id: req.factoryId,
      external_user_id: userId,
      messages: history,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// POST /chat/message
export async function saveMessage(req: ChatRequest, res: Response) {
  try {
    const { external_user_id, role, content, lead_id } = req.body;

    if (!external_user_id || !role || !content) {
      return res.status(400).json({
        error: "Missing required fields: external_user_id, role ('user' or 'bot'), content",
      });
    }

    const saved = await memoryService.saveChatMessage(
      req.factoryId!,
      external_user_id,
      role,
      content,
      lead_id
    );

    res.status(201).json({ success: true, message: saved });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

// POST /chat/mockup/save (Protected against empty strings, fake leadIds, and product names)
export async function saveMockupResult(req: ChatRequest, res: Response) {
  const client = await pool.connect();
  try {
    const { product_id, productId, logo_url, logoUrl, generated_image_url, generatedImageUrl, lead_id, leadId } = req.body;

    const rawProductId = product_id || productId;
    const rawLogoUrl = logo_url || logoUrl;
    const rawImageUrl = generated_image_url || generatedImageUrl;
    const rawLeadId = lead_id || leadId;

    if (!rawProductId || !rawLogoUrl || !rawImageUrl) {
      return res.status(400).json({
        error: "Missing required fields: product_id, logo_url, generated_image_url",
      });
    }

    // 1. Resolve Product UUID (handles names or UUIDs)
    const { findProductById } = await import("../services/db.service");
    const product = await findProductById(String(rawProductId), req.factoryId!);
    const resolvedProductId = product ? product.id : null;

    if (!resolvedProductId) {
      return res.status(404).json({ error: "Product not found" });
    }

    // 2. Foreign Key Defense for Lead ID
    let validLeadId: string | null = null;
    if (rawLeadId && typeof rawLeadId === "string" && rawLeadId.trim() !== "") {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawLeadId.trim());
      if (isUuid) {
        const leadCheck = await client.query("SELECT id FROM leads WHERE id = $1 AND factory_id = $2", [rawLeadId.trim(), req.factoryId]);
        if (leadCheck.rows.length > 0) validLeadId = leadCheck.rows[0].id;
      }
    }

    // 3. Safe Insert
    const result = await client.query(
      `INSERT INTO mockups (factory_id, product_id, logo_url, generated_image_url, lead_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.factoryId!, resolvedProductId, rawLogoUrl, rawImageUrl, validLeadId]
    );

    res.status(201).json({ success: true, mockup: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
}