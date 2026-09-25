import { pool } from "../config/db";

/**
 * Factory-editable commercial configuration.
 *
 * `discount_tiers` and `shipping_rates` were previously only insertable via raw
 * SQL (see DEVELOPER_BACKEND.md step 4), yet pricing.service.ts reads them on
 * every quote. These endpoints let a factory enter its real rules through the
 * dashboard so quoted prices are genuinely theirs.
 */

export interface FactorySettings {
  id: string;
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  username: string | null;
  logoUrl: string | null;
  plateCostDefault: number;
  colorFeeDefault: number;
  defaultCurrency: string;
  quoteValidityDays: number;
  monthlyMockupLimit: number;
}

function mapSettings(row: Record<string, any>): FactorySettings {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    country: row.country,
    email: row.email,
    phone: row.phone,
    username: row.username ?? null,
    logoUrl: row.logo_url ?? null,
    plateCostDefault: Number(row.plate_cost_default ?? 0),
    colorFeeDefault: Number(row.color_fee_default ?? 0),
    defaultCurrency: row.default_currency ?? "USD",
    quoteValidityDays: Number(row.quote_validity_days ?? 30),
    monthlyMockupLimit: Number(row.monthly_mockup_limit ?? 50),
  };
}

export async function getFactorySettings(factoryId: string): Promise<FactorySettings> {
  const result = await pool.query("SELECT * FROM factories WHERE id = $1", [factoryId]);
  if (result.rows.length === 0) throw new Error("Factory not found");
  return mapSettings(result.rows[0]);
}

export async function updateFactorySettings(
  factoryId: string,
  data: Partial<{
    name: string;
    type: string;
    country: string;
    email: string;
    phone: string;
    logoUrl: string;
    plateCostDefault: number;
    colorFeeDefault: number;
    defaultCurrency: string;
    quoteValidityDays: number;
  }>
): Promise<FactorySettings> {
  const result = await pool.query(
    `UPDATE factories SET
       name  = COALESCE($1, name),
       type  = COALESCE($2, type),
       country = COALESCE($3, country),
       email = COALESCE($4, email),
       phone = COALESCE($5, phone),
       logo_url = COALESCE($6, logo_url),
       plate_cost_default  = COALESCE($7, plate_cost_default),
       color_fee_default   = COALESCE($8, color_fee_default),
       default_currency    = COALESCE($9, default_currency),
       quote_validity_days = COALESCE($10, quote_validity_days)
     WHERE id = $11
     RETURNING *`,
    [
      data.name ?? null,
      data.type ?? null,
      data.country ?? null,
      data.email ?? null,
      data.phone ?? null,
      data.logoUrl ?? null,
      data.plateCostDefault ?? null,
      data.colorFeeDefault ?? null,
      data.defaultCurrency ?? null,
      data.quoteValidityDays ?? null,
      factoryId,
    ]
  );
  if (result.rows.length === 0) throw new Error("Factory not found");
  return mapSettings(result.rows[0]);
}

// --- Volume discount tiers ---------------------------------------------------

export interface DiscountTierView {
  id: string;
  minQuantity: number;
  discountPercent: number;
}

export async function listDiscountTiers(factoryId: string): Promise<DiscountTierView[]> {
  const result = await pool.query(
    "SELECT * FROM discount_tiers WHERE factory_id = $1 ORDER BY min_quantity ASC",
    [factoryId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    minQuantity: Number(r.min_quantity),
    discountPercent: Number(r.discount_percent),
  }));
}

export async function createDiscountTier(
  factoryId: string,
  minQuantity: number,
  discountPercent: number
): Promise<DiscountTierView> {
  const qty = Math.round(Number(minQuantity));
  const pct = Number(discountPercent);
  if (!Number.isFinite(qty) || qty < 1) {
    throw new Error("Minimum quantity must be at least 1");
  }
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error("Discount must be between 0 and 100 percent");
  }

  const result = await pool.query(
    `INSERT INTO discount_tiers (factory_id, min_quantity, discount_percent)
     VALUES ($1, $2, $3) RETURNING *`,
    [factoryId, qty, pct]
  );
  const r = result.rows[0];
  return {
    id: r.id,
    minQuantity: Number(r.min_quantity),
    discountPercent: Number(r.discount_percent),
  };
}

export async function deleteDiscountTier(factoryId: string, id: string): Promise<void> {
  const result = await pool.query(
    "DELETE FROM discount_tiers WHERE id = $1 AND factory_id = $2 RETURNING id",
    [id, factoryId]
  );
  if (result.rows.length === 0) throw new Error("Discount tier not found");
}

// --- Freight rates -----------------------------------------------------------

export interface ShippingRateView {
  id: string;
  destinationCountry: string | null;
  rateType: "flat" | "per_unit" | "per_kg";
  rateValue: number;
}

export async function listShippingRates(factoryId: string): Promise<ShippingRateView[]> {
  const result = await pool.query(
    `SELECT * FROM shipping_rates WHERE factory_id = $1
     ORDER BY destination_country NULLS LAST`,
    [factoryId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    destinationCountry: r.destination_country ?? null,
    rateType: r.rate_type,
    rateValue: Number(r.rate_value),
  }));
}

export async function createShippingRate(
  factoryId: string,
  destinationCountry: string | null,
  rateType: string,
  rateValue: number
): Promise<ShippingRateView> {
  if (!["flat", "per_unit", "per_kg"].includes(rateType)) {
    throw new Error("Rate type must be flat, per_unit or per_kg");
  }
  const value = Number(rateValue);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Rate value must be a positive number");
  }

  const result = await pool.query(
    `INSERT INTO shipping_rates (factory_id, destination_country, rate_type, rate_value)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [factoryId, destinationCountry?.trim() || null, rateType, value]
  );
  const r = result.rows[0];
  return {
    id: r.id,
    destinationCountry: r.destination_country ?? null,
    rateType: r.rate_type,
    rateValue: Number(r.rate_value),
  };
}

export async function deleteShippingRate(factoryId: string, id: string): Promise<void> {
  const result = await pool.query(
    "DELETE FROM shipping_rates WHERE id = $1 AND factory_id = $2 RETURNING id",
    [id, factoryId]
  );
  if (result.rows.length === 0) throw new Error("Shipping rate not found");
}
