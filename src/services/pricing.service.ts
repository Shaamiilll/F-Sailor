import { pool } from "../config/db";

export interface QuoteCalculationParams {
  factoryId: string;
  unitPrice: any;
  quantity: any;
  currency?: string;
  destinationCountry?: string;
  weightKg?: any;
  tradeTerm?: string;
  plateCost?: any;
  colorCount?: any;
  colorFeePerColor?: any;
  addonPricePerUnit?: any;
  addonName?: string;
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

// 🛡️ UNIVERSAL NUMBER SANITIZER: Strips "$", spaces, commas, and guarantees a real mathematical number
function toSafeNumber(val: any, fallback: number = 0): number {
  if (typeof val === "number") return isNaN(val) ? fallback : val;
  if (!val) return fallback;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? fallback : parsed;
}

export async function calculateQuote(params: QuoteCalculationParams): Promise<QuoteResult> {
  const {
    factoryId,
    unitPrice,
    quantity,
    currency = "USD",
    destinationCountry,
    weightKg,
    tradeTerm = "EXW",
    plateCost,
    colorCount,
    colorFeePerColor,
    addonPricePerUnit,
  } = params;

  // 1. Sanitize all numerical inputs
  const numUnitPrice = toSafeNumber(unitPrice, 0.10);
  const numAddonPrice = toSafeNumber(addonPricePerUnit, 0);
  const numQuantity = Math.max(1, Math.round(toSafeNumber(quantity, 1000)));
  const numPlateCost = toSafeNumber(plateCost, 0);
  const numColorCount = Math.max(1, Math.round(toSafeNumber(colorCount, 1)));
  const numColorFee = toSafeNumber(colorFeePerColor, 0);

  // 2. Strict Mathematical Addition (Guarantees NO string concatenation)
  const effectiveUnitPrice = Number((numUnitPrice + numAddonPrice).toFixed(4));
  const productSubtotal = Number((effectiveUnitPrice * numQuantity).toFixed(2));

  // 3. Dynamic Volume Discount from Database
  let discountPercent = 0;
  try {
    const tierRes = await pool.query(
      `SELECT discount_percent FROM discount_tiers 
       WHERE factory_id = $1 AND min_quantity <= $2 
       ORDER BY min_quantity DESC LIMIT 1`,
      [factoryId, numQuantity]
    );
    if (tierRes.rows.length > 0) {
      discountPercent = toSafeNumber(tierRes.rows[0].discount_percent, 0);
    }
  } catch (err) {
    discountPercent = 0;
  }

  const discountAmount = Number((productSubtotal * (discountPercent / 100)).toFixed(2));

  // 4. Custom Tooling & Printing Fees
  const extraColors = Math.max(0, numColorCount - 1);
  const colorFees = Number((extraColors * numColorFee).toFixed(2));
  const totalSetupFees = Number((numPlateCost + colorFees).toFixed(2));

  // 5. Freight / Trade Terms
  const normalizedTradeTerm = (tradeTerm || "EXW").trim().toUpperCase();
  let shippingCost = 0;

  if (normalizedTradeTerm === "EXW") {
    shippingCost = 0;
  } else if (normalizedTradeTerm === "FOB") {
    shippingCost = 75.00; // Flat local port handling
  } else {
    try {
      const shipRes = await pool.query(
        `SELECT rate_type, rate_value FROM shipping_rates 
         WHERE factory_id = $1 AND (destination_country = $2 OR destination_country IS NULL) 
         ORDER BY destination_country NULLS LAST LIMIT 1`,
        [factoryId, destinationCountry || null]
      );
      if (shipRes.rows.length > 0) {
        const rateVal = toSafeNumber(shipRes.rows[0].rate_value, 0);
        if (shipRes.rows[0].rate_type === "flat") shippingCost = rateVal;
        else if (shipRes.rows[0].rate_type === "per_unit") shippingCost = rateVal * numQuantity;
        else if (shipRes.rows[0].rate_type === "per_kg") shippingCost = rateVal * toSafeNumber(weightKg, 0);
      }
    } catch {
      shippingCost = 50.00;
    }
  }

  const totalPrice = Number((productSubtotal - discountAmount + totalSetupFees + shippingCost).toFixed(2));

  return {
    quantity: numQuantity,
    baseUnitPrice: numUnitPrice,
    addonPricePerUnit: numAddonPrice,
    effectiveUnitPrice,
    productSubtotal,
    discountPercent,
    discountAmount,
    plateCost: numPlateCost,
    colorFees,
    totalSetupFees,
    shippingCost,
    tradeTerm: normalizedTradeTerm,
    totalPrice,
    currency,
  };
}