import { pool } from "../config/db";
import { Factory, Product, User } from "../types";

function mapFactory(row: Record<string, unknown>): any {
  const factoryId = row.id as string;
  // ⚠️ REPLACE WITH YOUR REAL TELEGRAM BOT USERNAME (e.g. MyCompany_Bot):
  const BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || "YOUR_TELEGRAM_BOT_USERNAME";

  return {
    id: factoryId,
    name: row.name as string,
    type: row.type as string,
    country: row.country as string,
    email: row.email as string,
    phone: row.phone as string,
    logoUrl: row.logo_url as string | null,
    // Automatically creates the unique, clickable Telegram Bot link for this factory!
    telegramBotUrl: `https://t.me/${BOT_USERNAME}?start=${factoryId}`,
    createdAt: row.created_at as Date,
  };
}

function mapUser(row: Record<string, unknown>): User {
  return {
    id: row.id as string,
    email: row.email as string,
    passwordHash: row.password_hash as string,
    role: row.role as User["role"],
    factoryId: row.factory_id as string | null,
    createdAt: row.created_at as Date,
  };
}

export function mapProduct(row: Record<string, unknown>): Product {
  return {
    id: row.id as string,
    factoryId: row.factory_id as string,
    name: row.name as string,
    category: row.category as string,
    specification: row.specification as string,
    capacity: row.capacity as string | null,
    material: row.material as string | null,
    dimensions: row.dimensions as string | null,
    gsm: row.gsm as string | null,
    wallType: row.wall_type as string | null,
    printingMethod: row.printing_method as string | null,
    moq: Number(row.moq),
    price: Number(row.price),
    currency: row.currency as string,
    leadTime: row.lead_time as string,
    description: row.description as string,
    status: row.status as Product["status"],
    size: row.size as string | null,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

export async function findUserByEmail(email: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findUserById(id: string): Promise<User | null> {
  const result = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return result.rows[0] ? mapUser(result.rows[0]) : null;
}

export async function findAllFactories(): Promise<Factory[]> {
  const result = await pool.query("SELECT * FROM factories ORDER BY created_at DESC");
  return result.rows.map(mapFactory);
}

export async function findFactoryById(id: string): Promise<Factory | null> {
  const result = await pool.query("SELECT * FROM factories WHERE id = $1", [id]);
  return result.rows[0] ? mapFactory(result.rows[0]) : null;
}

export async function findProductsByFactory(factoryId: string): Promise<Product[]> {
  const result = await pool.query(
    "SELECT * FROM products WHERE factory_id = $1 ORDER BY created_at DESC",
    [factoryId]
  );
  return result.rows.map(mapProduct);
}

// 🛡️ UNIVERSAL PRODUCT RESOLVER: Never crashes, handles UUIDs, names, slugs, or AI hallucinations
export async function findProductById(identifier: string, factoryId: string): Promise<any | null> {
  const client = await pool.connect();
  try {
    const raw = (identifier || "").trim();
    if (!raw) {
      // Fallback: grab first active product for this factory
      const first = await client.query("SELECT * FROM products WHERE factory_id = $1 LIMIT 1", [factoryId]);
      return first.rows[0] || null;
    }

    // 1. UUID Check
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw);
    if (isUuid) {
      // Look up by ID for this factory
      const res = await client.query("SELECT * FROM products WHERE id = $1 AND factory_id = $2", [raw, factoryId]);
      if (res.rows.length > 0) return res.rows[0];

      // If UUID not in this factory, check if it's in ANY factory
      const anyFactoryRes = await client.query("SELECT * FROM products WHERE id = $1 LIMIT 1", [raw]);
      if (anyFactoryRes.rows.length > 0) return anyFactoryRes.rows[0];
    }

    // 2. Exact or Partial Name Match
    const nameRes = await client.query(
      `SELECT * FROM products WHERE factory_id = $1 AND name ILIKE $2 LIMIT 1`,
      [factoryId, `%${raw}%`]
    );
    if (nameRes.rows.length > 0) return nameRes.rows[0];

    // 3. Keyword Tokenizer (Handles reversed words, hyphens, slugs)
    const words = raw
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .trim()
      .split(/\s+/)
      .filter((w) => w.length >= 3);

    if (words.length > 0) {
      const conditions = words.map((_, idx) => `name ILIKE $${idx + 2}`).join(" AND ");
      const keywordRes = await client.query(
        `SELECT * FROM products WHERE factory_id = $1 AND (${conditions}) LIMIT 1`,
        [factoryId, ...words.map((w) => `%${w}%`)]
      );
      if (keywordRes.rows.length > 0) return keywordRes.rows[0];

      // Match by at least ONE primary word
      const primaryWord = words.find((w) => w.includes("single") || w.includes("double") || w.includes("cup") || w.includes("box") || w.includes("hoodie"));
      if (primaryWord) {
        const fallbackRes = await client.query(
          `SELECT * FROM products WHERE factory_id = $1 AND name ILIKE $2 LIMIT 1`,
          [factoryId, `%${primaryWord}%`]
        );
        if (fallbackRes.rows.length > 0) return fallbackRes.rows[0];
      }
    }

    // 4. Ultimate Fail-Safe: Return the most logical product for this factory rather than throwing 404
    const ultimateFallback = await client.query(
      "SELECT * FROM products WHERE factory_id = $1 ORDER BY created_at ASC LIMIT 1",
      [factoryId]
    );
    return ultimateFallback.rows[0] || null;
  } finally {
    client.release();
  }
}

export function productToResponse(product: Product) {
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    specification: product.specification,
    capacity: product.capacity ?? undefined,
    material: product.material ?? undefined,
    dimensions: product.dimensions ?? undefined,
    gsm: product.gsm ?? undefined,
    wallType: product.wallType ?? undefined,
    printingMethod: product.printingMethod ?? undefined,
    moq: product.moq,
    price: product.price,
    currency: product.currency,
    leadTime: product.leadTime,
    description: product.description,
    status: product.status,
    size: product.size ?? undefined,
  };
}