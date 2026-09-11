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

// POST /chat/mockup/save (Saves the result from whichever AI you use in n8n)
export async function saveMockupResult(req: ChatRequest, res: Response) {
  const client = await pool.connect();
  try {
    const { product_id, logo_url, generated_image_url, lead_id } = req.body;

    if (!product_id || !logo_url || !generated_image_url) {
      return res.status(400).json({
        error: "Missing required fields: product_id, logo_url, generated_image_url",
      });
    }

    const result = await client.query(
      `INSERT INTO mockups (factory_id, product_id, logo_url, generated_image_url, lead_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.factoryId!, product_id, logo_url, generated_image_url, lead_id || null]
    );

    res.status(201).json({ success: true, mockup: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
}