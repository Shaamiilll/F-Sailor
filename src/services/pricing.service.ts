import { pool } from "../config/db";

interface DiscountTier {
  minQuantity: number;
  discountPercent: number;
}

interface ShippingRate {
  rateType: "flat" | "per_unit" | "per_kg";
  rateValue: number;
}

export interface QuoteCalculationParams {
  factoryId: string;
  unitPrice: number;
  quantity: number;
  currency: string;
  destinationCountry?: string;
  weightKg?: number;
  // Client's Custom Manufacturing Fees:
  tradeTerm?: "EXW" | "FOB" | "DDP"; // EXW = Factory Ground, FOB = Port delivery, DDP = Door
  plateCost?: number;                // One-time printing plate / mold fee (e.g. $50)
  colorCount?: number;               // Number of print colors (e.g. 1 to 4)
  colorFeePerColor?: number;         // Setup fee per extra color (e.g. $20 per color)
  addonPricePerUnit?: number;        // e.g. Adding coffee lids (+ $0.03/unit)
  addonName?: string;                // e.g. "Matching Biodegradable Lids"
}

export interface QuoteResult {
  quantity: number;
  baseUnitPrice: number;
  addonPricePerUnit: number;
  effectiveUnitPrice: number;
  productSubtotal: number;
  discountPercent: number;
  discountAmount: number;
  plateCost: number;
  colorFees: number;
  totalSetupFees: number;
  shippingCost: number;
  tradeTerm: string;
  totalPrice: number;
  currency: string;
}

async function getBestDiscountTier(
  factoryId: string,
  quantity: number
): Promise<DiscountTier | null> {
  const result = await pool.query(
    `SELECT min_quantity, discount_percent
     FROM discount_tiers
     WHERE factory_id = $1 AND min_quantity <= $2
     ORDER BY min_quantity DESC
     LIMIT 1`,
    [factoryId, quantity]
  );
  if (result.rows.length === 0) return null;
  return {
    minQuantity: result.rows[0].min_quantity,
    discountPercent: Number(result.rows[0].discount_percent),
  };
}

async function getShippingRate(
  factoryId: string,
  destinationCountry?: string
): Promise<ShippingRate | null> {
  const result = await pool.query(
    `SELECT rate_type, rate_value
     FROM shipping_rates
     WHERE factory_id = $1 AND (destination_country = $2 OR destination_country IS NULL)
     ORDER BY destination_country NULLS LAST
     LIMIT 1`,
    [factoryId, destinationCountry || null]
  );
  if (result.rows.length === 0) return null;
  return {
    rateType: result.rows[0].rate_type,
    rateValue: Number(result.rows[0].rate_value),
  };
}

export async function calculateQuote(params: QuoteCalculationParams): Promise<QuoteResult> {
  const {
    factoryId,
    unitPrice,
    quantity,
    currency,
    destinationCountry,
    weightKg,
    tradeTerm = "EXW",
    plateCost = 0,
    colorCount = 1,
    colorFeePerColor = 0,
    addonPricePerUnit = 0,
  } = params;

  // 1. Calculate Product Subtotal
  const effectiveUnitPrice = unitPrice + addonPricePerUnit;
  const productSubtotal = effectiveUnitPrice * quantity;

  // 2. Volume Discount
  const tier = await getBestDiscountTier(factoryId, quantity);
  const discountPercent = tier?.discountPercent ?? 0;
  const discountAmount = productSubtotal * (discountPercent / 100);

  // 3. One-time Manufacturing Setup Fees (Plate + Multi-color)
  const extraColors = Math.max(0, colorCount - 1);
  const colorFees = extraColors * colorFeePerColor;
  const totalSetupFees = plateCost + colorFees;

  // 4. Shipping based on Trade Term:
  // EXW = Factory ground (Customer picks up = $0 shipping)
  // FOB = Delivery to nearest port ($75 flat handling fee)
  // DDP = Full door-to-door shipping from database rates
  let shippingCost = 0;
  if (tradeTerm === "EXW") {
    shippingCost = 0;
  } else if (tradeTerm === "FOB") {
    shippingCost = 75.00; // Standard local freight-to-port charge
  } else {
    // DDP / Standard door delivery
    const shipping = await getShippingRate(factoryId, destinationCountry);
    if (shipping) {
      if (shipping.rateType === "flat") shippingCost = shipping.rateValue;
      else if (shipping.rateType === "per_unit") shippingCost = shipping.rateValue * quantity;
      else if (shipping.rateType === "per_kg") shippingCost = shipping.rateValue * (weightKg ?? 0);
    }
  }

  // 5. Grand Total
  const totalPrice = (productSubtotal - discountAmount) + totalSetupFees + shippingCost;

  return {
    quantity,
    baseUnitPrice: unitPrice,
    addonPricePerUnit,
    effectiveUnitPrice,
    productSubtotal,
    discountPercent,
    discountAmount,
    plateCost,
    colorFees,
    totalSetupFees,
    shippingCost,
    tradeTerm,
    totalPrice,
    currency,
  };
}