import { PoolClient } from "pg";
import { pool } from "../config/db";

/**
 * Human-readable document numbers, e.g. QT-2026-000123 / ORD-2026-000123.
 *
 * Backed by Postgres sequences (created in migrate-commerce.ts) so two
 * concurrent requests can never collide -- nextval() is atomic and never
 * rolls back, which is exactly what we want for a document number.
 */
async function nextNumber(
  prefix: string,
  sequence: string,
  client?: PoolClient
): Promise<string> {
  const runner = client ?? pool;
  const result = await runner.query(`SELECT nextval('${sequence}') AS n`);
  const n = String(result.rows[0].n).padStart(6, "0");
  return `${prefix}-${new Date().getFullYear()}-${n}`;
}

export function nextQuoteNumber(client?: PoolClient): Promise<string> {
  return nextNumber("QT", "quote_number_seq", client);
}

export function nextOrderNumber(client?: PoolClient): Promise<string> {
  return nextNumber("ORD", "order_number_seq", client);
}

/**
 * Formats a Postgres DATE for JSON as plain YYYY-MM-DD.
 *
 * node-postgres hands a DATE back as a Date at *local* midnight, so calling
 * .toISOString() on it reports the previous day everywhere east of UTC (IST
 * turned 2026-10-25 into "2026-10-24T18:30:00Z"). Read the local components.
 */
export function toDateOnly(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}
