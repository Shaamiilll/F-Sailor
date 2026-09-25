import { pool } from "../config/db";
import { toDateOnly } from "./numbering.service";

/**
 * Read models for quotations.
 *
 * The dashboard table previously received raw `SELECT *` rows -- snake_case, no
 * customer, no line items, no quote number. Everything here returns the shape
 * the UI actually renders, and every query is scoped by factory (and by lead
 * for the customer portal) so tenants can never see each other's rows.
 */

export interface QuotationItemView {
  id: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  customization: string | null;
}

export interface QuotationView {
  id: string;
  quoteNumber: string | null;
  customerId: string | null;
  customerName: string;
  company: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerCountry: string | null;
  items: QuotationItemView[];
  quantity: number;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  setupFees: number;
  plateCost: number;
  colorCount: number;
  shipping: number;
  total: number;
  currency: string;
  status: string;
  tradeTerm: string | null;
  destinationCountry: string | null;
  notes: string | null;
  customerNotes: string | null;
  pdfUrl: string | null;
  source: string;
  validUntil: string | null;
  createdAt: Date;
  updatedAt: Date;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: string | null;
}

const SELECT_QUOTATION = `
  SELECT
    q.*,
    l.name    AS customer_name,
    l.company AS customer_company,
    l.email   AS customer_email,
    l.phone   AS customer_phone,
    l.country AS customer_country,
    o.id            AS order_id,
    o.order_number  AS order_number,
    o.status        AS order_status,
    COALESCE(
      (
        SELECT json_agg(
                 json_build_object(
                   'id', qi.id,
                   'productId', qi.product_id,
                   'productName', qi.product_name,
                   'quantity', qi.quantity,
                   'unitPrice', qi.unit_price,
                   'lineTotal', qi.line_total,
                   'customization', qi.customization
                 ) ORDER BY qi.sort_order, qi.created_at
               )
        FROM quotation_items qi
        WHERE qi.quotation_id = q.id
      ),
      '[]'::json
    ) AS items,
    p.name AS legacy_product_name
  FROM quotations q
  LEFT JOIN leads l    ON l.id = q.lead_id
  LEFT JOIN orders o   ON o.quotation_id = q.id
  LEFT JOIN products p ON p.id = q.product_id
`;

function mapQuotationView(row: Record<string, any>): QuotationView {
  let items: QuotationItemView[] = (row.items || []).map((i: any) => ({
    id: i.id,
    productId: i.productId,
    productName: i.productName,
    quantity: Number(i.quantity),
    unitPrice: Number(i.unitPrice),
    lineTotal: Number(i.lineTotal),
    customization: i.customization ?? null,
  }));

  // Quotations created by the chat/n8n gateway predate quotation_items and
  // store their single product on the quotation row itself. Present them as a
  // one-line quotation so every consumer can just read `items`.
  if (items.length === 0 && row.product_id) {
    items = [
      {
        id: `${row.id}-legacy`,
        productId: row.product_id,
        productName: row.legacy_product_name || "Custom manufactured product",
        quantity: Number(row.quantity),
        unitPrice: Number(row.unit_price),
        lineTotal: Number(row.subtotal),
        customization: null,
      },
    ];
  }

  return {
    id: row.id,
    quoteNumber: row.quote_number ?? null,
    customerId: row.lead_id ?? null,
    customerName: row.customer_name || "Unknown customer",
    company: row.customer_company || "",
    customerEmail: row.customer_email ?? null,
    customerPhone: row.customer_phone ?? null,
    customerCountry: row.customer_country ?? null,
    items,
    quantity: Number(row.quantity),
    subtotal: Number(row.subtotal),
    discountPercent: Number(row.discount_percent),
    discountAmount: Number(row.discount_amount),
    setupFees: Number(row.setup_fees ?? 0),
    plateCost: Number(row.plate_cost ?? 0),
    colorCount: Number(row.color_count ?? 1),
    shipping: Number(row.shipping_cost),
    total: Number(row.total_price),
    currency: row.currency,
    status: row.status,
    tradeTerm: row.trade_term ?? null,
    destinationCountry: row.destination_country ?? null,
    notes: row.notes ?? null,
    customerNotes: row.customer_notes ?? null,
    pdfUrl: row.pdf_url ?? null,
    source: row.source ?? "chatbot",
    validUntil: toDateOnly(row.valid_until),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    orderId: row.order_id ?? null,
    orderNumber: row.order_number ?? null,
    orderStatus: row.order_status ?? null,
  };
}

export async function listQuotationsForFactory(factoryId: string): Promise<QuotationView[]> {
  const result = await pool.query(
    `${SELECT_QUOTATION} WHERE q.factory_id = $1 ORDER BY q.created_at DESC`,
    [factoryId]
  );
  return result.rows.map(mapQuotationView);
}

export async function getQuotationForFactory(
  factoryId: string,
  id: string
): Promise<QuotationView | null> {
  const result = await pool.query(
    `${SELECT_QUOTATION} WHERE q.factory_id = $1 AND q.id = $2`,
    [factoryId, id]
  );
  return result.rows[0] ? mapQuotationView(result.rows[0]) : null;
}

export async function listQuotationsForLead(
  factoryId: string,
  leadId: string
): Promise<QuotationView[]> {
  const result = await pool.query(
    `${SELECT_QUOTATION}
     WHERE q.factory_id = $1 AND q.lead_id = $2
     ORDER BY q.created_at DESC`,
    [factoryId, leadId]
  );
  return result.rows.map(mapQuotationView);
}

export async function getQuotationForLead(
  factoryId: string,
  leadId: string,
  id: string
): Promise<QuotationView | null> {
  const result = await pool.query(
    `${SELECT_QUOTATION} WHERE q.factory_id = $1 AND q.lead_id = $2 AND q.id = $3`,
    [factoryId, leadId, id]
  );
  return result.rows[0] ? mapQuotationView(result.rows[0]) : null;
}
