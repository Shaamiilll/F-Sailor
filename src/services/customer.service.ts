import { pool } from "../config/db";
import { listQuotationsForLead } from "./quotation-view.service";
import { listOrdersForLead } from "./order.service";

/**
 * Dashboard read models for customers.
 *
 * "Customer" is the `leads` table -- the same row the chatbot upserts and the
 * storefront registers against, so a buyer who first arrived via Telegram and
 * later created a web account is one record, not two.
 */

export interface CustomerView {
  id: string;
  name: string;
  company: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  status: string;
  source: string;
  notes: string | null;
  hasAccount: boolean;
  openQuotes: number;
  totalQuotes: number;
  orders: number;
  totalSpend: number;
  currency: string;
  lastActivityAt: string | null;
  createdAt: Date;
}

const SELECT_CUSTOMER = `
  SELECT
    l.*,
    (l.password_hash IS NOT NULL) AS has_account,
    COALESCE(q.total_quotes, 0)   AS total_quotes,
    COALESCE(q.open_quotes, 0)    AS open_quotes,
    COALESCE(o.order_count, 0)    AS order_count,
    COALESCE(o.total_spend, 0)    AS total_spend,
    GREATEST(
      l.updated_at,
      COALESCE(q.last_quote_at, l.updated_at),
      COALESCE(o.last_order_at, l.updated_at)
    ) AS last_activity_at
  FROM leads l
  LEFT JOIN (
    SELECT
      lead_id,
      COUNT(*)                                                   AS total_quotes,
      COUNT(*) FILTER (WHERE status IN ('draft','pending','sent')) AS open_quotes,
      MAX(created_at)                                            AS last_quote_at
    FROM quotations
    GROUP BY lead_id
  ) q ON q.lead_id = l.id
  LEFT JOIN (
    SELECT
      lead_id,
      COUNT(*)         AS order_count,
      SUM(total_price) AS total_spend,
      MAX(created_at)  AS last_order_at
    FROM orders
    GROUP BY lead_id
  ) o ON o.lead_id = l.id
`;

function mapCustomerView(row: Record<string, any>): CustomerView {
  return {
    id: row.id,
    name: row.name || row.email || "Unnamed customer",
    company: row.company || "",
    email: row.email ?? null,
    phone: row.phone ?? null,
    country: row.country ?? null,
    status: row.status ?? "prospect",
    source: row.source ?? "chatbot",
    notes: row.notes ?? null,
    hasAccount: Boolean(row.has_account),
    openQuotes: Number(row.open_quotes),
    totalQuotes: Number(row.total_quotes),
    orders: Number(row.order_count),
    totalSpend: Number(row.total_spend),
    currency: "USD",
    lastActivityAt: row.last_activity_at
      ? new Date(row.last_activity_at).toISOString()
      : null,
    createdAt: row.created_at,
  };
}

export async function listCustomers(factoryId: string): Promise<CustomerView[]> {
  const result = await pool.query(
    `${SELECT_CUSTOMER} WHERE l.factory_id = $1 ORDER BY last_activity_at DESC`,
    [factoryId]
  );
  return result.rows.map(mapCustomerView);
}

export async function getCustomer(
  factoryId: string,
  id: string
): Promise<CustomerView | null> {
  const result = await pool.query(
    `${SELECT_CUSTOMER} WHERE l.factory_id = $1 AND l.id = $2`,
    [factoryId, id]
  );
  return result.rows[0] ? mapCustomerView(result.rows[0]) : null;
}

/** Full profile for the customer detail page: quotations, orders and a merged timeline. */
export async function getCustomerDetail(factoryId: string, id: string) {
  const customer = await getCustomer(factoryId, id);
  if (!customer) return null;

  const [quotations, orders, conversations] = await Promise.all([
    listQuotationsForLead(factoryId, id),
    listOrdersForLead(factoryId, id),
    pool.query(
      `SELECT s.id, s.external_user_id, s.last_active_at,
              (SELECT content FROM chat_messages m
                WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1) AS last_message
       FROM chat_sessions s
       WHERE s.factory_id = $1 AND s.lead_id = $2
       ORDER BY s.last_active_at DESC`,
      [factoryId, id]
    ),
  ]);

  const activity = [
    ...quotations.map((q) => ({
      id: `act-quote-${q.id}`,
      type: "quotation" as const,
      title: `Quotation ${q.quoteNumber ?? ""}`.trim(),
      description: `${q.currency} ${q.total.toFixed(2)} — ${q.status}`,
      timestamp: new Date(q.createdAt).toISOString(),
      href: `/dashboard/quotations/${q.id}`,
    })),
    ...orders.map((o) => ({
      id: `act-order-${o.id}`,
      type: "order" as const,
      title: `Order ${o.orderNumber}`,
      description: `${o.currency} ${o.total.toFixed(2)} — ${o.status.replace("_", " ")}`,
      timestamp: new Date(o.createdAt).toISOString(),
      href: `/dashboard/orders/${o.id}`,
    })),
    ...conversations.rows.map((c: any) => ({
      id: `act-conv-${c.id}`,
      type: "conversation" as const,
      title: "Conversation",
      description: c.last_message || "No messages yet",
      timestamp: new Date(c.last_active_at).toISOString(),
      href: `/dashboard/conversations`,
    })),
  ].sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  return { customer, quotations, orders, activity };
}

export async function updateCustomer(
  factoryId: string,
  id: string,
  data: { notes?: string | null; status?: string; name?: string; company?: string; phone?: string; country?: string }
): Promise<CustomerView> {
  if (data.status && !["prospect", "active", "inactive"].includes(data.status)) {
    throw new Error("Invalid customer status");
  }

  const result = await pool.query(
    `UPDATE leads SET
       notes   = COALESCE($1, notes),
       status  = COALESCE($2, status),
       name    = COALESCE($3, name),
       company = COALESCE($4, company),
       phone   = COALESCE($5, phone),
       country = COALESCE($6, country),
       updated_at = NOW()
     WHERE id = $7 AND factory_id = $8
     RETURNING id`,
    [
      data.notes ?? null,
      data.status ?? null,
      data.name ?? null,
      data.company ?? null,
      data.phone ?? null,
      data.country ?? null,
      id,
      factoryId,
    ]
  );
  if (result.rows.length === 0) throw new Error("Customer not found");
  return (await getCustomer(factoryId, id))!;
}
