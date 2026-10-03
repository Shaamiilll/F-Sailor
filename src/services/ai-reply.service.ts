import { GoogleGenAI } from "@google/genai";
import { pool } from "../config/db";
import { env } from "../config/env";

/**
 * Generates the automatic reply a buyer receives.
 *
 * The model is given the factory's own catalog and the recent conversation, and
 * told to answer only from that. An export buyer asking "what's your MOQ on
 * 16oz cups?" should get the factory's real number or an honest "let me check",
 * never a plausible-sounding invention -- a wrong MOQ or price quoted over
 * WhatsApp is a commercial problem, not just a bad answer.
 *
 * Uses @google/genai because it is the model client this project already
 * depends on.
 */

export type AiTone = "professional" | "friendly" | "concise";

const TONE_GUIDANCE: Record<AiTone, string> = {
  professional:
    "Write in clear, courteous business English suited to international trade correspondence.",
  friendly:
    "Write warmly and conversationally, as a helpful colleague would, while staying businesslike.",
  concise:
    "Answer in as few words as possible. Prefer short sentences and bullet points.",
};

export const AI_TONES: AiTone[] = ["professional", "friendly", "concise"];

export function isAiTone(value: unknown): value is AiTone {
  return typeof value === "string" && AI_TONES.includes(value as AiTone);
}

export const aiEnabled = Boolean(env.geminiApiKey);

let client: GoogleGenAI | null = null;
function genai(): GoogleGenAI {
  if (!client) client = new GoogleGenAI({ apiKey: env.geminiApiKey });
  return client;
}

interface CatalogProduct {
  name: string;
  category: string;
  moq: number;
  price: number;
  currency: string;
  leadTime: string;
  material: string | null;
  size: string | null;
  capacity: string | null;
  specification: string;
}

/**
 * The catalog the model is allowed to quote from. Only active products, and
 * capped, because the whole list goes into every prompt.
 */
async function loadCatalog(factoryId: string): Promise<CatalogProduct[]> {
  const result = await pool.query(
    `SELECT name, category, moq, price, currency, lead_time, material,
            size, capacity, specification
       FROM products
      WHERE factory_id = $1 AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 40`,
    [factoryId]
  );

  return result.rows.map((row) => ({
    name: row.name,
    category: row.category,
    moq: Number(row.moq),
    price: Number(row.price),
    currency: row.currency,
    leadTime: row.lead_time,
    material: row.material,
    size: row.size,
    capacity: row.capacity,
    specification: row.specification,
  }));
}

function renderCatalog(products: CatalogProduct[]): string {
  if (products.length === 0) {
    return "(This factory has not published any products yet.)";
  }

  return products
    .map((p) => {
      const bits = [
        `- ${p.name} (${p.category})`,
        `  MOQ: ${p.moq.toLocaleString()}`,
        `  Unit price: ${p.price} ${p.currency}`,
        p.leadTime ? `  Lead time: ${p.leadTime}` : null,
        p.material ? `  Material: ${p.material}` : null,
        p.size ? `  Size: ${p.size}` : null,
        p.capacity ? `  Capacity: ${p.capacity}` : null,
        p.specification ? `  Spec: ${p.specification.slice(0, 200)}` : null,
      ].filter(Boolean);
      return bits.join("\n");
    })
    .join("\n");
}

export interface ReplyContext {
  factoryId: string;
  factoryName: string;
  factoryType: string;
  country: string;
  tone: AiTone;
  /** Extra operator instructions from the configure page. */
  instructions: string;
  /** Oldest-first, the tail of the thread. */
  history: Array<{ role: "user" | "bot"; content: string }>;
  message: string;
  collectLeadDetails: boolean;
}

function buildSystemPrompt(ctx: ReplyContext, catalog: string): string {
  const lines = [
    `You are the sales assistant for ${ctx.factoryName}, a manufacturer${
      ctx.factoryType ? ` specialising in ${ctx.factoryType}` : ""
    }${ctx.country ? ` based in ${ctx.country}` : ""}.`,
    "You are replying to an international buyer over WhatsApp.",
    "",
    "PRODUCT CATALOG (the only product facts you may state):",
    catalog,
    "",
    "RULES:",
    "1. Quote prices, MOQs and lead times ONLY as they appear in the catalog above. Never estimate, round, or invent one.",
    "2. If the buyer asks about something not in the catalog, say you will check with the team and ask what they need. Do not guess.",
    "3. Never promise a discount, a delivery date, or payment terms. Those need a human.",
    "4. Keep replies short enough to read comfortably on a phone: a few sentences, or a short list.",
    "5. Do not use markdown headings or tables. WhatsApp renders *bold* with single asterisks.",
    "6. Reply in the language the buyer used.",
    TONE_GUIDANCE[ctx.tone],
  ];

  if (ctx.collectLeadDetails) {
    lines.push(
      "7. If you do not yet know it, ask for the buyer's name, company and destination country -- but ask for one thing at a time, never all at once, and only after you have answered their question."
    );
  }

  if (ctx.instructions.trim()) {
    lines.push("", "ADDITIONAL INSTRUCTIONS FROM THE FACTORY:", ctx.instructions.trim());
  }

  return lines.join("\n");
}

export class AiUnavailableError extends Error {
  code = "AI_UNAVAILABLE";
  constructor(message = "AI replies are not configured on this server.") {
    super(message);
    this.name = "AiUnavailableError";
  }
}

/**
 * Produces the reply text. Throws rather than returning a placeholder, so the
 * caller can fall back to the operator's configured fallback message instead of
 * sending the buyer something that looks like an error.
 */
export async function generateReply(ctx: ReplyContext): Promise<string> {
  if (!aiEnabled) throw new AiUnavailableError();

  const catalog = renderCatalog(await loadCatalog(ctx.factoryId));
  const systemPrompt = buildSystemPrompt(ctx, catalog);

  // Only the tail of the thread: enough for context, bounded so a long-running
  // conversation can't grow the prompt without limit.
  const contents = [
    ...ctx.history.slice(-12).map((m) => ({
      role: m.role === "bot" ? ("model" as const) : ("user" as const),
      parts: [{ text: m.content }],
    })),
    { role: "user" as const, parts: [{ text: ctx.message }] },
  ];

  const response = await genai().models.generateContent({
    model: env.geminiModel,
    contents,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.4,
      maxOutputTokens: 500,
    },
  });

  const text = (response.text ?? "").trim();
  if (!text) throw new Error("The model returned an empty reply");

  // WhatsApp hard-limits a text body at 4096 characters.
  return text.length > 4000 ? `${text.slice(0, 3997)}...` : text;
}
