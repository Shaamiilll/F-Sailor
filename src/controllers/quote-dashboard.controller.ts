import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import { pool } from "../config/db";
import * as quoteService from "../services/quote.service";
import * as quotationView from "../services/quotation-view.service";
import * as orderService from "../services/order.service";

export async function listQuotations(req: AuthRequest, res: Response) {
  try {
    res.json(await quotationView.listQuotationsForFactory(req.user!.factoryId!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getQuotation(req: AuthRequest, res: Response) {
  try {
    const quotation = await quotationView.getQuotationForFactory(
      req.user!.factoryId!,
      req.params.id as string
    );
    if (!quotation) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }
    res.json(quotation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/**
 * Approves a quotation and opens the order it becomes, in one transaction.
 *
 * This is the hinge of the whole flow: a quotation the customer submitted goes
 * `pending -> approved`, and an order appears on the Orders board. Idempotent --
 * `orders.quotation_id` is UNIQUE and createOrderFromQuotation checks first, so
 * a double-click cannot produce two orders.
 */
export async function approveQuotation(req: AuthRequest, res: Response) {
  const factoryId = req.user!.factoryId!;
  const id = req.params.id as string;
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const updated = await client.query(
      `UPDATE quotations SET status = 'approved', updated_at = NOW()
       WHERE id = $1 AND factory_id = $2 RETURNING id`,
      [id, factoryId]
    );
    if (updated.rows.length === 0) throw new Error("Quotation not found");

    const order = await orderService.createOrderFromQuotation(
      factoryId,
      id,
      req.user!.email,
      client
    );

    await client.query("COMMIT");

    const quotation = await quotationView.getQuotationForFactory(factoryId, id);
    res.json({ quotation, order });
  } catch (err) {
    await client.query("ROLLBACK");
    const message = (err as Error).message;
    res.status(message === "Quotation not found" ? 404 : 400).json({ error: message });
  } finally {
    client.release();
  }
}

export async function rejectQuotation(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    await quoteService.updateQuotationStatus(factoryId, req.params.id as string, "rejected");
    const quotation = await quotationView.getQuotationForFactory(
      factoryId,
      req.params.id as string
    );
    res.json({ quotation, order: null });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

/** Marks a draft/pending quotation as sent to the customer. */
export async function markQuotationSent(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const result = await pool.query(
      `UPDATE quotations SET status = 'sent', updated_at = NOW()
       WHERE id = $1 AND factory_id = $2 RETURNING id`,
      [req.params.id, factoryId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }
    res.json(await quotationView.getQuotationForFactory(factoryId, req.params.id as string));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/** Internal notes and validity date -- everything else is a priced snapshot. */
export async function updateQuotation(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const { notes, validUntil } = req.body;
    const result = await pool.query(
      `UPDATE quotations SET
         notes = COALESCE($1, notes),
         valid_until = COALESCE($2::DATE, valid_until),
         updated_at = NOW()
       WHERE id = $3 AND factory_id = $4 RETURNING id`,
      [notes ?? null, validUntil || null, req.params.id, factoryId]
    );
    if (result.rows.length === 0) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }
    res.json(await quotationView.getQuotationForFactory(factoryId, req.params.id as string));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function renderQuotationPdf(req: AuthRequest, res: Response) {
  try {
    const { pdfUrl } = await quoteService.generateQuotationPdf(
      req.user!.factoryId!,
      req.params.id as string
    );
    res.json({ pdfUrl });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}
