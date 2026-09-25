import { pool } from "../config/db";

/**
 * Read models for the Conversations inbox and the Mockups gallery.
 *
 * Both read tables the chat/n8n gateway already writes (`chat_sessions`,
 * `chat_messages`, `mockups`), so a factory that has never used the bot sees a
 * genuine empty state rather than sample traffic.
 */

export interface ConversationView {
  id: string;
  customerId: string | null;
  customerName: string;
  company: string;
  email: string | null;
  /** Derived from the external id the gateway used (telegram:… / web_…). */
  channel: "whatsapp" | "website" | "email" | "telegram" | "other";
  externalUserId: string;
  messageCount: number;
  lastMessage: string | null;
  lastMessageAt: string;
  createdAt: string;
  quotationCount: number;
  orderCount: number;
}

function detectChannel(externalUserId: string): ConversationView["channel"] {
  const id = (externalUserId || "").toLowerCase();
  if (id.startsWith("telegram") || /^\d{6,}$/.test(id)) return "telegram";
  if (id.startsWith("whatsapp") || id.startsWith("wa_") || id.startsWith("+")) {
    return "whatsapp";
  }
  if (id.startsWith("web") || id.startsWith("site")) return "website";
  if (id.includes("@")) return "email";
  return "other";
}

export async function listConversations(factoryId: string): Promise<ConversationView[]> {
  const result = await pool.query(
    `SELECT
       s.id,
       s.lead_id,
       s.external_user_id,
       s.created_at,
       s.last_active_at,
       l.name    AS customer_name,
       l.company AS customer_company,
       l.email   AS customer_email,
       (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS message_count,
       (SELECT m.content FROM chat_messages m
         WHERE m.session_id = s.id
         ORDER BY m.created_at DESC LIMIT 1) AS last_message,
       (SELECT COUNT(*) FROM quotations q WHERE q.lead_id = s.lead_id) AS quotation_count,
       (SELECT COUNT(*) FROM orders o WHERE o.lead_id = s.lead_id) AS order_count
     FROM chat_sessions s
     LEFT JOIN leads l ON l.id = s.lead_id
     WHERE s.factory_id = $1
     ORDER BY s.last_active_at DESC`,
    [factoryId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    customerId: row.lead_id ?? null,
    customerName: row.customer_name || row.customer_email || "Unidentified visitor",
    company: row.customer_company || "",
    email: row.customer_email ?? null,
    channel: detectChannel(row.external_user_id),
    externalUserId: row.external_user_id,
    messageCount: Number(row.message_count),
    lastMessage: row.last_message ?? null,
    lastMessageAt: new Date(row.last_active_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    quotationCount: Number(row.quotation_count),
    orderCount: Number(row.order_count),
  }));
}

export interface ChatMessageView {
  id: string;
  role: "user" | "bot";
  content: string;
  createdAt: string;
}

export async function getConversationMessages(
  factoryId: string,
  sessionId: string
): Promise<ChatMessageView[] | null> {
  const owned = await pool.query(
    "SELECT id FROM chat_sessions WHERE id = $1 AND factory_id = $2",
    [sessionId, factoryId]
  );
  if (owned.rows.length === 0) return null;

  const result = await pool.query(
    `SELECT id, role, content, created_at FROM chat_messages
      WHERE session_id = $1 ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}

export interface MockupView {
  id: string;
  productId: string;
  productName: string;
  productImageUrl: string | null;
  customerId: string | null;
  customerName: string | null;
  logoUrl: string;
  generatedImageUrl: string | null;
  createdAt: string;
}

export async function listMockups(factoryId: string): Promise<MockupView[]> {
  const result = await pool.query(
    `SELECT m.*, p.name AS product_name, p.image_url AS product_image_url,
            l.name AS customer_name, l.company AS customer_company
       FROM mockups m
       LEFT JOIN products p ON p.id = m.product_id
       LEFT JOIN leads l ON l.id = m.lead_id
      WHERE m.factory_id = $1
      ORDER BY m.created_at DESC`,
    [factoryId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    productId: row.product_id,
    productName: row.product_name || "Deleted product",
    productImageUrl: row.product_image_url ?? null,
    customerId: row.lead_id ?? null,
    customerName: row.customer_name || row.customer_company || null,
    logoUrl: row.logo_url,
    generatedImageUrl: row.generated_image_url ?? null,
    createdAt: new Date(row.created_at).toISOString(),
  }));
}
