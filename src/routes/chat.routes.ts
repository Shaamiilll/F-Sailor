import * as mockupController from "../controllers/mockup.controller";
import { Router, Response } from "express";
import { chatAuthMiddleware, ChatRequest } from "../middleware/chat.middleware";
import * as leadController from "../controllers/lead.controller";
import * as quoteController from "../controllers/quote.controller";
import * as memoryController from "../controllers/chat-memory.controller";
import * as productService from "../services/product.service";
import { findProductById } from "../services/db.service";
import { pool } from "../config/db";

const router = Router();

// Every route below requires the x-factory-id header
router.use(chatAuthMiddleware);

// GET /api/chat/info (Returns factory name, type, country, and logo)
router.get("/info", async (req: ChatRequest, res: Response): Promise<void> => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT id, name, type, country, email, logo_url FROM factories WHERE id = $1",
        [req.factoryId]
      );
      if (result.rows.length === 0) {
        res.status(404).json({ error: "Factory not found" });
        return;
      }
      res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- 1. PRODUCT ENDPOINTS ---
// Get all products (includes blank image_url for mockups)
router.get("/products", async (req: ChatRequest, res: Response): Promise<void> => {
  try {
    const products = await productService.listProducts(req.factoryId!);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
import fs from "fs";
import path from "path";

// POST /api/chat/upload (Converts any uploaded customer logo into a clean, short URL!)
router.post("/upload", async (req: ChatRequest, res: Response): Promise<void> => {
  try {
    const { imageBase64, filename } = req.body;
    if (!imageBase64) {
      res.status(400).json({ error: "No image provided" });
      return;
    }

    const uploadDir = path.join(__dirname, "../../uploads/logos");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    // Clean base64 and write directly to disk
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, "");
    const ext = (filename || "logo.png").split(".").pop() || "png";
    const savedName = `logo-${Date.now()}.${ext}`;
    const filePath = path.join(uploadDir, savedName);

    fs.writeFileSync(filePath, Buffer.from(base64Data, "base64"));

    // Return the clean, short public URL!
    const logoUrl = `/uploads/logos/${savedName}`;
    res.json({ success: true, logoUrl });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
// Get a single product by ID OR by Product Name (No Red Lines!)
router.get("/products/:id", async (req: ChatRequest, res: Response): Promise<void> => {
  try {
    const product = await findProductById(req.params.id, req.factoryId!);

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json(product);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// --- 2. CHAT MEMORY ENDPOINTS ---
// Get conversation history for a user
router.get("/history/:userId", memoryController.getHistory);
// Save a user or bot message
router.post("/message", memoryController.saveMessage);

// --- 3. LEADS & QUOTES ---
router.post("/leads", leadController.saveLead);
router.post("/quote", quoteController.createQuote);
router.get("/quote/:id", quoteController.getQuote);
router.post("/quote/:id/pdf", quoteController.generatePdf);
router.post("/quote/:id/approve", quoteController.approveQuote);
router.post("/quote/:id/reject", quoteController.rejectQuote);

// --- 4. MOCKUP STORAGE ---
// Saves any image created by n8n (Gemini, DALL-E, FLUX, etc.)
// Generate pixel-perfect mockup using Sharp
router.post("/mockup", mockupController.createMockup);
router.post("/mockup/save", memoryController.saveMockupResult);
// GET /api/chat/mockup/quota (Checks if factory has reached its monthly Mockup Generation limit)
router.get("/mockup/quota", async (req: ChatRequest, res: Response) => {
  const client = await pool.connect();
  try {
    // 1. Get factory monthly limit
    const fResult = await client.query(
      "SELECT monthly_mockup_limit FROM factories WHERE id = $1",
      [req.factoryId]
    );
    const limit = fResult.rows[0]?.monthly_mockup_limit || 50;

    // 2. Count how many mockups this factory generated this month
    const countResult = await client.query(
      `SELECT COUNT(*) as count FROM mockups 
       WHERE factory_id = $1 
         AND created_at >= date_trunc('month', CURRENT_DATE)`,
      [req.factoryId]
    );
    const used = parseInt(countResult.rows[0].count);

    // 3. Return quota status
    const allowed = used < limit;
    res.json({
      allowed,
      used,
      limit,
      remaining: Math.max(0, limit - used)
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    client.release();
  }
});
export default router;