import { PoolClient } from "pg";
import { pool } from "../config/db";
import { nextOrderNumber, toDateOnly } from "./numbering.service";
import { ORDER_STATUSES, OrderStatus } from "../types";

export interface OrderItemView {
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  customization: string | null;
}

export interface OrderView {
  id: string;
  orderNumber: string;
  factoryId: string;
  customerId: string | null;
  customerName: string;
  company: string;
  customerEmail: string | null;
  quotationId: string | null;
  quoteNumber: string | null;
  items: OrderItemView[];
  total: number;
  currency: string;
  status: OrderStatus;
  estimatedDelivery: string | null;
  trackingNumber: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT_ORDER = `
  SELECT
    o.*,
    l.name    AS customer_name,
    l.company AS customer_company,
    l.email   AS customer_email,
    q.quote_number AS quote_number,
    COALESCE(
      (
        SELECT json_agg(
                 json_build_object(
                   'productId', qi.product_id,
                   'productName', qi.product_name,
                   'quantity', qi.quantity,
                   'unitPrice', qi.unit_price,
                   'lineTotal', qi.line_total,
                   'customization', qi.customization
                 ) ORDER BY qi.sort_order, qi.created_at
               )
        FROM quotation_items qi
        WHERE qi.quotation_id = o.quotation_id
      ),
      '[]'::json
    ) AS items
  FROM orders o
  LEFT JOIN leads l ON l.id = o.lead_id
  LEFT JOIN quotations q ON q.id = o.quotation_id
`;

function mapOrder(row: Record<string, any>): OrderView {
  return {
    id: row.id,
    orderNumber: row.order_number,
    factoryId: row.factory_id,
    customerId: row.lead_id ?? null,
    customerName: row.customer_name || "Unknown customer",
    company: row.customer_company || "",
    customerEmail: row.customer_email ?? null,
    quotationId: row.quotation_id ?? null,
    quoteNumber: row.quote_number ?? null,
    items: (row.items || []).map((i: any) => ({
      productId: i.productId,
      productName: i.productName,
      quantity: Number(i.quantity),
      unitPrice: Number(i.unitPrice),
      lineTotal: Number(i.lineTotal),
      customization: i.customization ?? null,
    })),
    total: Number(row.total_price),
    currency: row.currency,
    status: row.status,
    estimatedDelivery: toDateOnly(row.estimated_delivery),
    trackingNumber: row.tracking_number ?? null,
    notes: row.notes ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Turns an approved quotation into an order.
 *
 * Idempotent: `orders.quotation_id` is UNIQUE and we check for an existing
 * order first, so approving the same quotation twice returns the order that
 * already exists instead of creating a duplicate.
 *
 * Accepts an optional client so the caller can run this inside the same
 * transaction that flips the quotation's status.
 */
export async function createOrderFromQuotation(
  factoryId: string,
  quotationId: string,
  changedBy?: string,
  externalClient?: PoolClient
): Promise<OrderView> {
  const client = externalClient ?? (await pool.connect());
  const ownsClient = !externalClient;

  try {
    if (ownsClient) await client.query("BEGIN");

    const existing = await client.query(
      "SELECT id FROM orders WHERE quotation_id = $1 AND factory_id = $2",
      [quotationId, factoryId]
    );
    if (existing.rows.length > 0) {
      const alreadyThere = (await getOrder(factoryId, existing.rows[0].id, client))!;
      if (ownsClient) await client.query("COMMIT");
      return alreadyThere;
    }

    const quoteRes = await client.query(
      "SELECT * FROM quotations WHERE id = $1 AND factory_id = $2",
      [quotationId, factoryId]
    );
    const quote = quoteRes.rows[0];
    if (!quote) throw new Error("Quotation not found");

    const orderNumber = await nextOrderNumber(client);
    const inserted = await client.query(
      `INSERT INTO orders (
         factory_id, lead_id, quotation_id, order_number,
         total_price, currency, status
       ) VALUES ($1, $2, $3, $4, $5, $6, 'accepted')
       RETURNING id`,
      [factoryId, quote.lead_id, quotationId, orderNumber, quote.total_price, quote.currency]
    );

    const orderId = inserted.rows[0].id;
    await client.query(
      `INSERT INTO order_status_history (order_id, status, note, changed_by)
       VALUES ($1, 'accepted', $2, $3)`,
      [
        orderId,
        `Created from approved quotation ${quote.quote_number ?? quotationId}`,
        changedBy ?? null,
      ]
    );

    // Read back on the same client: with an external client the INSERT above is
    // still inside the caller's uncommitted transaction.
    const created = (await getOrder(factoryId, orderId, client))!;
    if (ownsClient) await client.query("COMMIT");
    return created;
  } catch (err) {
    if (ownsClient) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

export async function listOrders(factoryId: string): Promise<OrderView[]> {
  const result = await pool.query(
    `${SELECT_ORDER} WHERE o.factory_id = $1 ORDER BY o.created_at DESC`,
    [factoryId]
  );
  return result.rows.map(mapOrder);
}

/**
 * `runner` lets a caller read inside its own open transaction. Without it an
 * order inserted but not yet committed reads back as null over the pool.
 */
export async function getOrder(
  factoryId: string,
  id: string,
  runner: Pick<PoolClient, "query"> = pool
): Promise<OrderView | null> {
  const result = await runner.query(
    `${SELECT_ORDER} WHERE o.factory_id = $1 AND o.id = $2`,
    [factoryId, id]
  );
  return result.rows[0] ? mapOrder(result.rows[0]) : null;
}

export async function listOrdersForLead(
  factoryId: string,
  leadId: string
): Promise<OrderView[]> {
  const result = await pool.query(
    `${SELECT_ORDER} WHERE o.factory_id = $1 AND o.lead_id = $2 ORDER BY o.created_at DESC`,
    [factoryId, leadId]
  );
  return result.rows.map(mapOrder);
}

export async function getOrderStatusHistory(factoryId: string, orderId: string) {
  const result = await pool.query(
    `SELECT h.* FROM order_status_history h
     JOIN orders o ON o.id = h.order_id
     WHERE h.order_id = $1 AND o.factory_id = $2
     ORDER BY h.created_at ASC`,
    [orderId, factoryId]
  );
  return result.rows.map((row) => ({
    id: row.id as string,
    status: row.status as OrderStatus,
    note: (row.note as string) ?? null,
    changedBy: (row.changed_by as string) ?? null,
    createdAt: row.created_at as Date,
  }));
}

export async function updateOrderStatus(
  factoryId: string,
  id: string,
  status: string,
  note?: string,
  changedBy?: string
): Promise<OrderView> {
  if (!ORDER_STATUSES.includes(status as OrderStatus)) {
    throw new Error(`Invalid order status. Expected one of: ${ORDER_STATUSES.join(", ")}`);
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE orders SET status = $1, updated_at = NOW()
       WHERE id = $2 AND factory_id = $3 RETURNING id`,
      [status, id, factoryId]
    );
    if (updated.rows.length === 0) throw new Error("Order not found");

    await client.query(
      `INSERT INTO order_status_history (order_id, status, note, changed_by)
       VALUES ($1, $2, $3, $4)`,
      [id, status, note?.trim() || null, changedBy ?? null]
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return (await getOrder(factoryId, id))!;
}

export async function updateOrder(
  factoryId: string,
  id: string,
  data: {
    estimatedDelivery?: string | null;
    trackingNumber?: string | null;
    notes?: string | null;
  }
): Promise<OrderView> {
  const result = await pool.query(
    `UPDATE orders SET
       estimated_delivery = COALESCE($1::DATE, estimated_delivery),
       tracking_number    = COALESCE($2, tracking_number),
       notes              = COALESCE($3, notes),
       updated_at = NOW()
     WHERE id = $4 AND factory_id = $5
     RETURNING id`,
    [
      data.estimatedDelivery || null,
      data.trackingNumber ?? null,
      data.notes ?? null,
      id,
      factoryId,
    ]
  );
  if (result.rows.length === 0) throw new Error("Order not found");
  return (await getOrder(factoryId, id))!;
}
