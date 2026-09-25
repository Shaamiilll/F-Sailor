import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import { env } from "../config/env";
import { createOrUpdateLead } from "./lead.service";
import { JwtPayload } from "../types";

export interface CustomerProfile {
  id: string;
  factoryId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  country: string | null;
  status: string;
  createdAt: Date;
}

export function mapCustomer(row: Record<string, unknown>): CustomerProfile {
  return {
    id: row.id as string,
    factoryId: row.factory_id as string,
    name: (row.name as string) ?? null,
    email: (row.email as string) ?? null,
    phone: (row.phone as string) ?? null,
    company: (row.company as string) ?? null,
    country: (row.country as string) ?? null,
    status: (row.status as string) ?? "prospect",
    createdAt: row.created_at as Date,
  };
}

function issueToken(factoryId: string, lead: CustomerProfile): string {
  const payload: JwtPayload = {
    userId: lead.id,
    email: lead.email ?? "",
    role: "customer",
    factoryId,
    leadId: lead.id,
  };
  return jwt.sign(payload, env.jwtSecret, { expiresIn: "30d" });
}

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  company?: string | null;
  phone?: string | null;
  country?: string | null;
}

/**
 * Creates a storefront account. Reuses the existing lead upsert so a buyer the
 * chatbot already met keeps one customer record -- registering just attaches a
 * password to it. If the account already has a password we refuse rather than
 * overwrite it, otherwise anyone could take over an existing account.
 */
export async function registerCustomer(factoryId: string, input: RegisterInput) {
  const email = input.email.trim().toLowerCase();

  const existing = await pool.query(
    "SELECT id, password_hash FROM leads WHERE factory_id = $1 AND LOWER(email) = $2",
    [factoryId, email]
  );

  if (existing.rows.length > 0 && existing.rows[0].password_hash) {
    throw new Error("An account with this email already exists. Please sign in instead.");
  }

  if (!input.password || input.password.length < 6) {
    throw new Error("Password must be at least 6 characters");
  }

  const lead = await createOrUpdateLead(factoryId, {
    name: input.name,
    email,
    phone: input.phone ?? null,
    company: input.company ?? null,
    country: input.country ?? null,
    source: "storefront",
  });

  const hash = await bcrypt.hash(input.password, 10);
  const updated = await pool.query(
    `UPDATE leads SET password_hash = $1, status = 'active', updated_at = NOW()
     WHERE id = $2 RETURNING *`,
    [hash, lead.id]
  );

  const customer = mapCustomer(updated.rows[0]);
  return { token: issueToken(factoryId, customer), customer };
}

export async function loginCustomer(factoryId: string, email: string, password: string) {
  const result = await pool.query(
    "SELECT * FROM leads WHERE factory_id = $1 AND LOWER(email) = $2",
    [factoryId, email.trim().toLowerCase()]
  );

  const row = result.rows[0];
  if (!row || !row.password_hash) {
    throw new Error("Invalid email or password");
  }

  const valid = await bcrypt.compare(password, row.password_hash);
  if (!valid) {
    throw new Error("Invalid email or password");
  }

  const customer = mapCustomer(row);
  return { token: issueToken(factoryId, customer), customer };
}

export async function getCustomerProfile(
  factoryId: string,
  leadId: string
): Promise<CustomerProfile | null> {
  const result = await pool.query(
    "SELECT * FROM leads WHERE id = $1 AND factory_id = $2",
    [leadId, factoryId]
  );
  return result.rows[0] ? mapCustomer(result.rows[0]) : null;
}
