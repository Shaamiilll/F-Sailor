import { pool } from "../config/db";
import { calculateQuote } from "./pricing.service";
import { findProductById, findFactoryById } from "./db.service";
import { generateQuotationPdf as buildPdf } from "./pdf.service";
import { Quotation } from "../types";

function mapQuotation(row: Record<string, unknown>): Quotation {
  return {
    id: row.id as string,
    factoryId: row.factory_id as string,
    leadId: row.lead_id as string | null,
    productId: row.product_id as string | null,
    quantity: row.quantity as number,
    unitPrice: Number(row.unit_price),
    discountPercent: Number(row.discount_percent),
    discountAmount: Number(row.discount_amount),
    shippingCost: Number(row.shipping_cost),
    subtotal: Number(row.subtotal),
    totalPrice: Number(row.total_price),
    currency: row.currency as string,
    status: row.status as Quotation["status"],
    pdfUrl: row.pdf_url as string | null,
    createdAt: row.created_at as Date,
  };
}

export async function createQuotation(
  factoryId: string,
  params: {
    leadId?: string;
    productId: string;
    quantity: any;
    destinationCountry?: string;
    weightKg?: any;
    tradeTerm?: string;
    plateCost?: any;
    colorCount?: any;
    colorFeePerColor?: any;
    addonPricePerUnit?: any;
    addonName?: string;
  }
): Promise<Quotation> {
  const client = await pool.connect();
  try {
    // 🛡️ 1. DETECT AI ID SWAPS: Did the AI pass leadId as productId?
    let targetProductId = params.productId;
    let targetLeadId = params.leadId;

    if (targetProductId && targetProductId === targetLeadId) {
      // AI had a brain freeze and copied the same ID into both slots!
      // Check if this ID is in leads
      const isLead = await client.query("SELECT id FROM leads WHERE id = $1", [targetProductId]);
      if (isLead.rows.length > 0) {
        targetLeadId = targetProductId;
        targetProductId = "cup"; // Reset to semantic search
      }
    }

    // 🛡️ 2. SAFE PRODUCT RESOLUTION
    const product = await findProductById(targetProductId, factoryId);
    if (!product) throw new Error("Product resolution failed");

    // 🛡️ 3. SAFE FOREIGN KEY VERIFICATION (Prevents "violates foreign key constraint" crashes)
    let validLeadId: string | null = null;
    if (targetLeadId && typeof targetLeadId === "string" && targetLeadId.trim() !== "") {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(targetLeadId.trim());
      if (isUuid) {
        const leadCheck = await client.query(
          "SELECT id FROM leads WHERE id = $1 AND factory_id = $2",
          [targetLeadId.trim(), factoryId]
        );
        if (leadCheck.rows.length > 0) {
          validLeadId = leadCheck.rows[0].id;
        }
      }
    }

    // 🛡️ 4. AUTO-LINK TO ACTIVE CUSTOMER IF LEAD WAS MISSED
    if (!validLeadId) {
      const latestLead = await client.query(
        "SELECT id FROM leads WHERE factory_id = $1 ORDER BY updated_at DESC LIMIT 1",
        [factoryId]
      );
      if (latestLead.rows.length > 0) {
        validLeadId = latestLead.rows[0].id;
      }
    }

    // 🛡️ 5. CALCULATE DETERMINISTIC PRICING
    const quote = await calculateQuote({
      factoryId,
      unitPrice: product.price,
      quantity: params.quantity,
      currency: product.currency,
      destinationCountry: params.destinationCountry,
      weightKg: params.weightKg,
      tradeTerm: params.tradeTerm,
      plateCost: params.plateCost,
      colorCount: params.colorCount,
      colorFeePerColor: params.colorFeePerColor,
      addonPricePerUnit: params.addonPricePerUnit,
      addonName: params.addonName,
    });

    // 🛡️ 6. INSERT PERMANENT SNAPSHOT
    const result = await client.query(
      `INSERT INTO quotations (
        factory_id, lead_id, product_id, quantity, unit_price,
        discount_percent, discount_amount, shipping_cost, subtotal,
        total_price, currency, status, plate_cost, color_count, trade_term
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'draft',$12,$13,$14)
      RETURNING *`,
      [
        factoryId,
        validLeadId,
        product.id,
        quote.quantity,
        quote.effectiveUnitPrice,
        quote.discountPercent,
        quote.discountAmount,
        quote.shippingCost + quote.totalSetupFees,
        quote.productSubtotal,
        quote.totalPrice,
        quote.currency,
        quote.plateCost,
        quote.colorFees > 0 ? (params.colorCount || 2) : 1,
        quote.tradeTerm || "EXW",
      ]
    );

    return mapQuotation(result.rows[0]);
  } finally {
    client.release();
  }
}

export async function getQuotation(factoryId: string, id: string): Promise<Quotation> {
  const result = await pool.query(
    "SELECT * FROM quotations WHERE id = $1 AND factory_id = $2",
    [id, factoryId]
  );
  if (result.rows.length === 0) throw new Error("Quotation not found");
  return mapQuotation(result.rows[0]);
}

export async function generateQuotationPdf(factoryId: string, id: string): Promise<{ pdfUrl: string; leadEmail: string | null }> {
  const q = await getQuotation(factoryId, id);
  const product = q.productId ? await findProductById(q.productId, factoryId) : null;
  const factory = await findFactoryById(factoryId);

  let leadName: string | null = null;
  let leadCompany: string | null = null;
  let leadEmail: string | null = null;

  if (q.leadId) {
    const leadResult = await pool.query(
      "SELECT name, company, email FROM leads WHERE id = $1",
      [q.leadId]
    );
    if (leadResult.rows.length > 0) {
      leadName = leadResult.rows[0].name;
      leadCompany = leadResult.rows[0].company;
      leadEmail = leadResult.rows[0].email;
    }
  }

  const pdfUrl = await buildPdf({
    quotationId: q.id,
    factoryName: factory?.name || "Factory",
    factoryLogoPath: (factory as any)?.logo_url || (factory as any)?.logoUrl || null,
    factoryEmail: factory?.email,
    factoryCountry: factory?.country,
    productName: product?.name || "Custom Manufactured Product",
    quantity: q.quantity,
    unitPrice: q.unitPrice,
    discountPercent: q.discountPercent,
    discountAmount: q.discountAmount,
    shippingCost: q.shippingCost,
    totalPrice: q.totalPrice,
    currency: q.currency,
    leadName,
    leadCompany,
    leadEmail,
  });

  await pool.query(
    "UPDATE quotations SET pdf_url = $1, status = 'sent', updated_at = NOW() WHERE id = $2",
    [pdfUrl, q.id]
  );

  return { pdfUrl, leadEmail };
}
export async function updateQuotationStatus(
  factoryId: string,
  id: string,
  status: "approved" | "rejected"
): Promise<Quotation> {
  const result = await pool.query(
    "UPDATE quotations SET status = $1, updated_at = NOW() WHERE id = $2 AND factory_id = $3 RETURNING *",
    [status, id, factoryId]
  );
  if (result.rows.length === 0) throw new Error("Quotation not found");
  return mapQuotation(result.rows[0]);
}
