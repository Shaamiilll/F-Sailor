import { Request, Response, NextFunction } from "express";
import { pool } from "../config/db";

export interface ChatRequest extends Request {
  factoryId?: string;
}

// The chatbot doesn't log in like a human factory user does. Instead,
// each n8n bot is configured once with its factory's ID, and sends it
// as a header on every request. This checks that the ID is real before
// letting the request through, and scopes everything after this point.
export async function chatAuthMiddleware(
  req: ChatRequest,
  res: Response,
  next: NextFunction
) {
  const factoryId = req.header("x-factory-id");

  if (!factoryId) {
    res.status(401).json({ error: "Missing x-factory-id header" });
    return;
  }

  const result = await pool.query("SELECT id FROM factories WHERE id = $1", [
    factoryId,
  ]);

  if (result.rows.length === 0) {
    res.status(401).json({ error: "Unknown factory id" });
    return;
  }

  req.factoryId = factoryId;
  next();
}
