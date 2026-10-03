import crypto from "crypto";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  decryptSecret,
  encryptSecret,
  generateVerifyToken,
  maskSecret,
  safeEqual,
} from "./crypto.service";
import * as aiReply from "./ai-reply.service";
import * as chatMemory from "./chat-memory.service";
import * as leadService from "./lead.service";

/**
 * WhatsApp Business automation, on Meta's Cloud API.
 *
 * Each factory connects its own WhatsApp number, so everything here is scoped
 * by `phone_number_id` -- that is the only identifier an inbound webhook
 * carries, and it is what tells us whose buyer is messaging.
 *
 * The automation loop is: Meta posts a message -> we find the factory -> record
 * it against the existing chat tables -> generate a reply from that factory's
 * catalog -> send it back through the Graph API.
 */

const GRAPH_VERSION = "v21.0";
const GRAPH_URL = `https://graph.facebook.com/${GRAPH_VERSION}`;

export class WhatsAppError extends Error {
  code: string;
  constructor(message: string, code = "WHATSAPP_ERROR") {
    super(message);
    this.name = "WhatsAppError";
    this.code = code;
  }
}

// --- Config ------------------------------------------------------------------

export interface WhatsAppConfig {
  factoryId: string;
  phoneNumberId: string | null;
  wabaId: string | null;
  displayPhoneNumber: string | null;
  /** Masked. The real token is never returned to a client. */
  accessToken: string | null;
  appSecret: string | null;
  hasAccessToken: boolean;
  hasAppSecret: boolean;
  verifyToken: string;
  webhookUrl: string;
  status: "not_connected" | "connected" | "error";
  lastError: string | null;
  lastVerifiedAt: Date | null;
  autoReplyEnabled: boolean;
  aiEnabled: boolean;
  aiTone: aiReply.AiTone;
  aiInstructions: string;
  greetingMessage: string;
  awayMessage: string;
  fallbackMessage: string;
  businessHours: BusinessHours;
  handoverKeywords: string[];
  collectLeadDetails: boolean;
}

export interface BusinessHours {
  enabled: boolean;
  timezone: string;
  /** Keys are mon..sun; a missing day means closed. */
  days: Record<string, { open: string; close: string }>;
}

const DEFAULT_HOURS: BusinessHours = { enabled: false, timezone: "UTC", days: {} };

function publicWebhookUrl(): string {
  const base = env.publicApiUrl.replace(/\/+$/, "");
  return `${base}/api/whatsapp/webhook`;
}

function mapConfig(row: Record<string, any>): WhatsAppConfig {
  const accessToken = decryptSecret(row.access_token_encrypted);
  const appSecret = decryptSecret(row.app_secret_encrypted);

  return {
    factoryId: row.factory_id,
    phoneNumberId: row.phone_number_id,
    wabaId: row.waba_id,
    displayPhoneNumber: row.display_phone_number,
    accessToken: maskSecret(accessToken),
    appSecret: maskSecret(appSecret),
    hasAccessToken: Boolean(accessToken),
    hasAppSecret: Boolean(appSecret),
    verifyToken: row.verify_token,
    webhookUrl: publicWebhookUrl(),
    status: row.status,
    lastError: row.last_error,
    lastVerifiedAt: row.last_verified_at,
    autoReplyEnabled: row.auto_reply_enabled,
    aiEnabled: row.ai_enabled,
    aiTone: row.ai_tone,
    aiInstructions: row.ai_instructions ?? "",
    greetingMessage: row.greeting_message ?? "",
    awayMessage: row.away_message ?? "",
    fallbackMessage: row.fallback_message ?? "",
    businessHours: { ...DEFAULT_HOURS, ...(row.business_hours ?? {}) },
    handoverKeywords: row.handover_keywords ?? [],
    collectLeadDetails: row.collect_lead_details,
  };
}

/** Reads the factory's config, creating the row (with a verify token) on first use. */
export async function getConfig(factoryId: string): Promise<WhatsAppConfig> {
  const existing = await pool.query(
    "SELECT * FROM whatsapp_configs WHERE factory_id = $1",
    [factoryId]
  );
  if (existing.rows[0]) return mapConfig(existing.rows[0]);

  const created = await pool.query(
    `INSERT INTO whatsapp_configs (factory_id, verify_token)
     VALUES ($1, $2)
     ON CONFLICT (factory_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [factoryId, generateVerifyToken()]
  );
  return mapConfig(created.rows[0]);
}

export interface UpdateConfigInput {
  phoneNumberId?: string;
  wabaId?: string;
  displayPhoneNumber?: string;
  /** Plaintext; encrypted before storage. Omit to keep the stored value. */
  accessToken?: string;
  appSecret?: string;
  autoReplyEnabled?: boolean;
  aiEnabled?: boolean;
  aiTone?: string;
  aiInstructions?: string;
  greetingMessage?: string;
  awayMessage?: string;
  fallbackMessage?: string;
  businessHours?: BusinessHours;
  handoverKeywords?: string[];
  collectLeadDetails?: boolean;
}

export async function updateConfig(
  factoryId: string,
  input: UpdateConfigInput
): Promise<WhatsAppConfig> {
  await getConfig(factoryId); // ensure the row exists

  if (input.aiTone !== undefined && !aiReply.isAiTone(input.aiTone)) {
    throw new WhatsAppError(
      `Tone must be one of: ${aiReply.AI_TONES.join(", ")}`,
      "VALIDATION"
    );
  }

  // An empty string means "leave it alone" -- the client never receives the real
  // token, so it cannot echo it back, and a blank field must not wipe it.
  const accessToken = input.accessToken?.trim()
    ? encryptSecret(input.accessToken.trim())
    : null;
  const appSecret = input.appSecret?.trim()
    ? encryptSecret(input.appSecret.trim())
    : null;

  const result = await pool.query(
    `UPDATE whatsapp_configs SET
       phone_number_id = COALESCE($2, phone_number_id),
       waba_id = COALESCE($3, waba_id),
       display_phone_number = COALESCE($4, display_phone_number),
       access_token_encrypted = COALESCE($5, access_token_encrypted),
       app_secret_encrypted = COALESCE($6, app_secret_encrypted),
       auto_reply_enabled = COALESCE($7, auto_reply_enabled),
       ai_enabled = COALESCE($8, ai_enabled),
       ai_tone = COALESCE($9, ai_tone),
       ai_instructions = COALESCE($10, ai_instructions),
       greeting_message = COALESCE($11, greeting_message),
       away_message = COALESCE($12, away_message),
       fallback_message = COALESCE($13, fallback_message),
       business_hours = COALESCE($14::jsonb, business_hours),
       handover_keywords = COALESCE($15, handover_keywords),
       collect_lead_details = COALESCE($16, collect_lead_details),
       updated_at = NOW()
     WHERE factory_id = $1
     RETURNING *`,
    [
      factoryId,
      input.phoneNumberId?.trim() || null,
      input.wabaId?.trim() || null,
      input.displayPhoneNumber?.trim() || null,
      accessToken,
      appSecret,
      input.autoReplyEnabled ?? null,
      input.aiEnabled ?? null,
      input.aiTone ?? null,
      input.aiInstructions ?? null,
      input.greetingMessage ?? null,
      input.awayMessage ?? null,
      input.fallbackMessage ?? null,
      input.businessHours ? JSON.stringify(input.businessHours) : null,
      input.handoverKeywords ?? null,
      input.collectLeadDetails ?? null,
    ]
  );

  return mapConfig(result.rows[0]);
}

export async function disconnect(factoryId: string): Promise<WhatsAppConfig> {
  const result = await pool.query(
    `UPDATE whatsapp_configs SET
       phone_number_id = NULL,
       waba_id = NULL,
       display_phone_number = NULL,
       access_token_encrypted = NULL,
       app_secret_encrypted = NULL,
       status = 'not_connected',
       last_error = NULL,
       last_verified_at = NULL,
       updated_at = NOW()
     WHERE factory_id = $1
     RETURNING *`,
    [factoryId]
  );
  if (!result.rows[0]) throw new WhatsAppError("No WhatsApp configuration found");
  return mapConfig(result.rows[0]);
}

/** The decrypted credentials, for server-side use only. */
async function getCredentials(
  factoryId: string
): Promise<{ phoneNumberId: string; accessToken: string }> {
  const result = await pool.query(
    "SELECT phone_number_id, access_token_encrypted FROM whatsapp_configs WHERE factory_id = $1",
    [factoryId]
  );
  const row = result.rows[0];
  const accessToken = decryptSecret(row?.access_token_encrypted);

  if (!row?.phone_number_id || !accessToken) {
    throw new WhatsAppError(
      "WhatsApp isn't connected yet. Add your phone number ID and access token first.",
      "NOT_CONNECTED"
    );
  }
  return { phoneNumberId: row.phone_number_id, accessToken };
}

async function setStatus(
  factoryId: string,
  status: "connected" | "error",
  error: string | null
): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_configs SET
       status = $2,
       last_error = $3,
       last_verified_at = CASE WHEN $2 = 'connected' THEN NOW() ELSE last_verified_at END,
       updated_at = NOW()
     WHERE factory_id = $1`,
    [factoryId, status, error]
  );
}

// --- Meta Graph API ----------------------------------------------------------

async function graphRequest(
  path: string,
  accessToken: string,
  init: RequestInit = {}
): Promise<any> {
  const response = await fetch(`${GRAPH_URL}/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers as Record<string, string>),
    },
  });

  const body: any = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Meta nests the useful part; the top-level message is usually generic.
    const detail =
      body?.error?.error_user_msg || body?.error?.message || response.statusText;
    throw new WhatsAppError(`WhatsApp API: ${detail}`, "GRAPH_ERROR");
  }
  return body;
}

/**
 * Checks the stored credentials against Meta and records the outcome, so the
 * dashboard can show "connected" with confidence rather than only after the
 * first buyer messages in.
 */
export async function verifyConnection(factoryId: string): Promise<WhatsAppConfig> {
  try {
    const { phoneNumberId, accessToken } = await getCredentials(factoryId);
    const info = await graphRequest(
      `${phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`,
      accessToken
    );

    await pool.query(
      `UPDATE whatsapp_configs SET display_phone_number = $2 WHERE factory_id = $1`,
      [factoryId, info.display_phone_number ?? null]
    );
    await setStatus(factoryId, "connected", null);
  } catch (err) {
    await setStatus(factoryId, "error", (err as Error).message);
    throw err;
  }

  return getConfig(factoryId);
}

/** Sends a free-form text message. Only valid inside the 24-hour window. */
export async function sendText(
  factoryId: string,
  to: string,
  text: string
): Promise<string> {
  const { phoneNumberId, accessToken } = await getCredentials(factoryId);

  const result = await graphRequest(`${phoneNumberId}/messages`, accessToken, {
    method: "POST",
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: false, body: text },
    }),
  });

  return result?.messages?.[0]?.id ?? "";
}

// --- Webhook -----------------------------------------------------------------

/**
 * Meta's subscription handshake: it calls with the verify token we gave it and
 * expects `hub.challenge` echoed back verbatim.
 *
 * The token is matched in constant time and across all tenants, since the
 * handshake carries no factory identifier.
 */
export async function verifyWebhookSubscription(
  mode: string,
  token: string,
  challenge: string
): Promise<string | null> {
  if (mode !== "subscribe" || !token) return null;

  const result = await pool.query(
    "SELECT verify_token FROM whatsapp_configs WHERE verify_token IS NOT NULL"
  );
  const matched = result.rows.some((row) => safeEqual(row.verify_token, token));

  return matched ? challenge : null;
}

/**
 * Validates Meta's `X-Hub-Signature-256` over the raw body.
 *
 * The app secret is per-factory, and the signature is checked before we parse
 * anything, so we try each configured secret. There are few tenants with
 * WhatsApp connected, and a request that matches none is rejected.
 *
 * Returns true when no app secret is configured anywhere -- signature checking
 * is opt-in, because a factory can run the integration without sharing its app
 * secret, and refusing every webhook in that case would break the feature
 * rather than secure it.
 */
export async function isValidSignature(
  rawBody: Buffer,
  signature: string | undefined
): Promise<boolean> {
  const result = await pool.query(
    "SELECT app_secret_encrypted FROM whatsapp_configs WHERE app_secret_encrypted IS NOT NULL"
  );

  const secrets = result.rows
    .map((row) => decryptSecret(row.app_secret_encrypted))
    .filter((s): s is string => Boolean(s));

  if (secrets.length === 0) return true;
  if (!signature?.startsWith("sha256=")) return false;

  const provided = signature.slice("sha256=".length);

  return secrets.some((secret) => {
    const expected = crypto
      .createHmac("sha256", secret)
      .update(rawBody)
      .digest("hex");
    return safeEqual(expected, provided);
  });
}

interface InboundMessage {
  phoneNumberId: string;
  from: string;
  messageId: string;
  text: string;
  contactName: string | null;
}

/** Pulls the text messages out of Meta's deeply nested webhook envelope. */
export function parseInboundMessages(payload: any): InboundMessage[] {
  const messages: InboundMessage[] = [];

  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      if (!value?.messages) continue;

      const phoneNumberId = value?.metadata?.phone_number_id;
      if (!phoneNumberId) continue;

      const contactName = value?.contacts?.[0]?.profile?.name ?? null;

      for (const message of value.messages) {
        // Only text for now. Images, audio and documents still open a
        // conversation window but there is nothing to answer from yet.
        const text =
          message?.text?.body ??
          message?.button?.text ??
          message?.interactive?.list_reply?.title ??
          message?.interactive?.button_reply?.title ??
          null;

        if (!text) continue;

        messages.push({
          phoneNumberId,
          from: message.from,
          messageId: message.id,
          text,
          contactName,
        });
      }
    }
  }

  return messages;
}

async function findFactoryByPhoneNumberId(phoneNumberId: string) {
  const result = await pool.query(
    `SELECT c.*, f.name AS factory_name, f.type AS factory_type,
            f.country AS factory_country, f.status AS factory_status
       FROM whatsapp_configs c
       JOIN factories f ON f.id = c.factory_id
      WHERE c.phone_number_id = $1`,
    [phoneNumberId]
  );
  return result.rows[0] ?? null;
}

/** First write wins; a redelivery of the same message id returns false. */
async function claimMessage(messageId: string, factoryId: string): Promise<boolean> {
  const result = await pool.query(
    `INSERT INTO whatsapp_inbound_messages (wa_message_id, factory_id)
     VALUES ($1, $2)
     ON CONFLICT (wa_message_id) DO NOTHING
     RETURNING id`,
    [messageId, factoryId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Finds the open 24-hour window for this contact, or opens a new one. The
 * monthly count of these rows is what the dashboard shows against Meta's free
 * tier of 1,000 service conversations.
 */
async function getOrOpenConversation(
  factoryId: string,
  contact: string,
  contactName: string | null,
  sessionId: string,
  leadId: string | null
) {
  const open = await pool.query(
    `SELECT * FROM whatsapp_conversations
      WHERE factory_id = $1 AND wa_contact_id = $2 AND expires_at > NOW()
      ORDER BY opened_at DESC LIMIT 1`,
    [factoryId, contact]
  );

  if (open.rows[0]) {
    await pool.query(
      `UPDATE whatsapp_conversations
          SET inbound_count = inbound_count + 1,
              contact_name = COALESCE($2, contact_name)
        WHERE id = $1`,
      [open.rows[0].id, contactName]
    );
    return open.rows[0];
  }

  const created = await pool.query(
    `INSERT INTO whatsapp_conversations
       (factory_id, session_id, lead_id, wa_contact_id, contact_name, inbound_count)
     VALUES ($1, $2, $3, $4, $5, 1)
     RETURNING *`,
    [factoryId, sessionId, leadId, contact, contactName]
  );
  return created.rows[0];
}

function withinBusinessHours(hours: BusinessHours): boolean {
  if (!hours?.enabled) return true;

  const now = new Date();
  // Intl does the timezone conversion without pulling in a date library.
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone || "UTC",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const weekday = (parts.find((p) => p.type === "weekday")?.value ?? "").toLowerCase();
  const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";

  const window = hours.days?.[weekday];
  if (!window?.open || !window?.close) return false;

  const current = `${hour}:${minute}`;
  return current >= window.open && current <= window.close;
}

function mentionsHandover(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((k) => k.trim() && lower.includes(k.trim().toLowerCase()));
}

/**
 * Handles one inbound message end to end.
 *
 * Every exit path is intentionally quiet: this runs from a webhook we have
 * already acknowledged, so an error here must be logged, not thrown at Meta --
 * a non-2xx would make it redeliver the same message.
 */
export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  const config = await findFactoryByPhoneNumberId(message.phoneNumberId);
  if (!config) {
    console.warn(`[whatsapp] No factory for phone_number_id ${message.phoneNumberId}`);
    return;
  }

  const factoryId = config.factory_id as string;

  if (!(await claimMessage(message.messageId, factoryId))) return;

  // A lapsed subscription shouldn't keep consuming the factory's WhatsApp quota
  // or our AI budget.
  if (!["active", "past_due"].includes(config.factory_status)) {
    console.warn(`[whatsapp] Factory ${factoryId} is ${config.factory_status} -- ignoring`);
    return;
  }

  const externalUserId = `whatsapp:${message.from}`;

  // Record the buyer and the message against the shared chat tables, so the
  // thread shows up in the Conversations inbox like any other channel.
  const lead = await leadService
    .createOrUpdateLead(factoryId, {
      name: message.contactName ?? undefined,
      phone: message.from,
      source: "whatsapp",
    })
    .catch(() => null);

  const leadId = (lead as any)?.id ?? null;

  const session = await chatMemory.saveChatMessage(
    factoryId,
    externalUserId,
    "user",
    message.text,
    leadId ?? undefined
  );

  const sessionId = (session as any)?.session_id ?? (session as any)?.id ?? null;

  const conversation = await getOrOpenConversation(
    factoryId,
    message.from,
    message.contactName,
    sessionId,
    leadId
  );

  if (!config.auto_reply_enabled) return;

  // A human is on this thread -- stay out of the way.
  if (conversation.handover) return;

  if (mentionsHandover(message.text, config.handover_keywords ?? [])) {
    await pool.query(
      "UPDATE whatsapp_conversations SET handover = TRUE WHERE id = $1",
      [conversation.id]
    );
    await sendAndRecord(
      factoryId,
      message.from,
      externalUserId,
      leadId,
      conversation.id,
      "Thanks — I'm connecting you with someone from our team. They'll reply here shortly."
    );
    return;
  }

  const hours = { ...DEFAULT_HOURS, ...(config.business_hours ?? {}) };
  if (!withinBusinessHours(hours) && config.away_message?.trim()) {
    await sendAndRecord(
      factoryId,
      message.from,
      externalUserId,
      leadId,
      conversation.id,
      config.away_message.trim()
    );
    return;
  }

  // A greeting only on the first message of a new window, so a returning buyer
  // isn't re-greeted mid-conversation.
  if (conversation.inbound_count <= 1 && config.greeting_message?.trim()) {
    await sendAndRecord(
      factoryId,
      message.from,
      externalUserId,
      leadId,
      conversation.id,
      config.greeting_message.trim()
    );
  }

  if (!config.ai_enabled) return;

  let replyText: string;
  try {
    const history = await chatMemory
      .getChatHistory(factoryId, externalUserId)
      .catch(() => []);

    replyText = await aiReply.generateReply({
      factoryId,
      factoryName: config.factory_name,
      factoryType: config.factory_type ?? "",
      country: config.factory_country ?? "",
      tone: config.ai_tone,
      instructions: config.ai_instructions ?? "",
      history: normalizeHistory(history).slice(0, -1),
      message: message.text,
      collectLeadDetails: config.collect_lead_details,
    });
  } catch (err) {
    console.error(`[whatsapp] Reply generation failed for ${factoryId}:`, err);
    const fallback = config.fallback_message?.trim();
    // Silence is better than an error string: the factory's team still sees the
    // message in the inbox and can answer it themselves.
    if (!fallback) return;
    replyText = fallback;
  }

  await sendAndRecord(
    factoryId,
    message.from,
    externalUserId,
    leadId,
    conversation.id,
    replyText
  );
}

/** Chat history rows come back in a couple of shapes; normalise to one. */
function normalizeHistory(history: any): Array<{ role: "user" | "bot"; content: string }> {
  const rows = Array.isArray(history) ? history : (history?.messages ?? []);
  return rows
    .map((row: any) => ({
      role: row.role === "bot" ? ("bot" as const) : ("user" as const),
      content: String(row.content ?? ""),
    }))
    .filter((m: { content: string }) => m.content);
}

async function sendAndRecord(
  factoryId: string,
  to: string,
  externalUserId: string,
  leadId: string | null,
  conversationId: string,
  text: string
): Promise<void> {
  try {
    await sendText(factoryId, to, text);
    await chatMemory.saveChatMessage(
      factoryId,
      externalUserId,
      "bot",
      text,
      leadId ?? undefined
    );
    await pool.query(
      "UPDATE whatsapp_conversations SET outbound_count = outbound_count + 1 WHERE id = $1",
      [conversationId]
    );
  } catch (err) {
    console.error(`[whatsapp] Send failed for factory ${factoryId}:`, err);
    await setStatus(factoryId, "error", (err as Error).message).catch(() => undefined);
  }
}

// --- Usage -------------------------------------------------------------------

export interface WhatsAppUsage {
  conversationsThisMonth: number;
  freeTierLimit: number;
  remaining: number;
  openWindows: number;
  messagesThisMonth: number;
  handovers: number;
}

/**
 * Meta's free tier is 1,000 service conversations per month, which is what
 * "you get 1000 chats" refers to. Counted as conversation windows, not
 * messages, because that is the unit Meta bills.
 */
export const FREE_TIER_CONVERSATIONS = 1000;

export async function getUsage(factoryId: string): Promise<WhatsAppUsage> {
  const result = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE opened_at >= date_trunc('month', CURRENT_DATE))::int AS conversations,
       COUNT(*) FILTER (WHERE expires_at > NOW())::int AS open_windows,
       COALESCE(SUM(inbound_count + outbound_count)
         FILTER (WHERE opened_at >= date_trunc('month', CURRENT_DATE)), 0)::int AS messages,
       COUNT(*) FILTER (WHERE handover AND opened_at >= date_trunc('month', CURRENT_DATE))::int AS handovers
     FROM whatsapp_conversations
     WHERE factory_id = $1`,
    [factoryId]
  );

  const row = result.rows[0] ?? {};
  const used = row.conversations ?? 0;

  return {
    conversationsThisMonth: used,
    freeTierLimit: FREE_TIER_CONVERSATIONS,
    remaining: Math.max(0, FREE_TIER_CONVERSATIONS - used),
    openWindows: row.open_windows ?? 0,
    messagesThisMonth: row.messages ?? 0,
    handovers: row.handovers ?? 0,
  };
}

/** Lets a factory hand a thread back to the bot after a human has finished. */
export async function setHandover(
  factoryId: string,
  conversationId: string,
  handover: boolean
): Promise<void> {
  await pool.query(
    "UPDATE whatsapp_conversations SET handover = $3 WHERE id = $2 AND factory_id = $1",
    [factoryId, conversationId, handover]
  );
}
