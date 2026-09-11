import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as quoteService from "../services/quote.service";

export async function createQuote(req: ChatRequest, res: Response) {
  try {
    const {
      leadId,
      productId,
      quantity,
      destinationCountry,
      weightKg,
      tradeTerm,
      plateCost,
      colorCount,
      colorFeePerColor,
      addonPricePerUnit,
      addonName,
    } = req.body;

    if (!productId || !quantity) {
      res.status(400).json({ error: "productId and quantity are required" });
      return;
    }

    const quotation = await quoteService.createQuotation(req.factoryId!, {
      leadId,
      productId,
      quantity: Number(quantity),
      destinationCountry,
      weightKg: weightKg ? Number(weightKg) : undefined,
      tradeTerm: tradeTerm || "EXW",
      plateCost: plateCost ? Number(plateCost) : (tradeTerm === "FOB" ? 50 : 0),
      colorCount: colorCount ? Number(colorCount) : 2,
      colorFeePerColor: colorFeePerColor ? Number(colorFeePerColor) : 20,
      addonPricePerUnit: addonPricePerUnit ? Number(addonPricePerUnit) : undefined,
      addonName,
    });

    res.status(201).json(quotation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getQuote(req: ChatRequest, res: Response) {
  try {
    const quotation = await quoteService.getQuotation(
      req.factoryId!,
      req.params.id as string
    );
    res.json(quotation);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function generatePdf(req: ChatRequest, res: Response) {
  try {
    const pdfUrl = await quoteService.generateQuotationPdf(
      req.factoryId!,
      req.params.id as string
    );

    // Also fetch the factory email so n8n gets it directly!
    const client = await (await import("../config/db")).pool.connect();
    let ownerEmail = "sales@factory.com";
    try {
      const fResult = await client.query("SELECT email FROM factories WHERE id = $1", [req.factoryId]);
      if (fResult.rows.length > 0 && fResult.rows[0].email) {
        ownerEmail = fResult.rows[0].email;
      }
    } finally {
      client.release();
    }

    res.json({ pdfUrl, ownerEmail });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

