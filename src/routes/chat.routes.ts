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

// --- 4. MOCKUP STORAGE ---
// Saves any image created by n8n (Gemini, DALL-E, FLUX, etc.)
router.post("/mockup/save", memoryController.saveMockupResult);

export default router;