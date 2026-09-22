import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { pool } from "../config/db";
import * as quoteService from "../services/quote.service";

export async function listQuotations(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId;
    const result = await pool.query(
      "SELECT * FROM quotations WHERE factory_id = $1 ORDER BY created_at DESC",
      [factoryId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function approveQuotation(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const quotation = await quoteService.updateQuotationStatus(factoryId, req.params.id as string, "approved");
    res.json(quotation);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function rejectQuotation(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const quotation = await quoteService.updateQuotationStatus(factoryId, req.params.id as string, "rejected");
    res.json(quotation);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}