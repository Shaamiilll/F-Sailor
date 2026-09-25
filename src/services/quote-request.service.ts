import { pool } from "../config/db";
import { calculateQuote } from "./pricing.service";
import { nextQuoteNumber } from "./numbering.service";
import { QuoteRequestInput, QuoteRequestLine } from "../types";

export interface PricedLine {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  moq: number;
  currency: string;
  customization: string | null;
}

export interface QuotePreview {
  lines: PricedLine[];
  currency: string;
  totalQuantity: number;
  subtotal: number;
  discountPercent: number;
  discountAmount: number;
  setupFees: number;
  plateCost: number;
  colorFees: number;
  shippingCost: number;
  tradeTerm: string;
  total: number;
}

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * Resolves and prices a cart.
 *
 * Volume discount, freight and setup fees all come from `calculateQuote`, which
 * reads the factory's real `discount_tiers` / `shipping_rates` rows. Because a
 * cart has several unit prices, we hand the engine a blended unit price and the
 * combined quantity purely to *derive the rules* (which tier applies, what the
 * freight is), then rebuild the money from the exact per-line sums -- a blended
 * price rounded to 4dp would otherwise drift by a few cents at 50,000 units.
 */
export async function priceQuoteRequest(
  factoryId: string,
  input: QuoteRequestInput
): Promise<QuotePreview> {
  const lines = (input.lines || []).filter((l) => l && l.productId);
  if (lines.length === 0) {
    throw new Error("Add at least one product before requesting a quotation");
  }

  const factoryRes = await pool.query(
    "SELECT plate_cost_default, color_fee_default, default_currency FROM factories WHERE id = $1",
    [factoryId]
  );
  const factory = factoryRes.rows[0] ?? {};

  const priced: PricedLine[] = [];
  for (const line of lines as QuoteRequestLine[]) {
    const productRes = await pool.query(
      "SELECT id, name, price, currency, moq, status FROM products WHERE id = $1 AND factory_id = $2",
      [line.productId, factoryId]
    );
    const product = productRes.rows[0];
    if (!product) {
      throw new Error(`Product not available from this factory`);
    }
    if (product.status !== "active") {
      throw new Error(`"${product.name}" is not currently available`);
    }

    const moq = Number(product.moq) || 0;
    const quantity = Math.round(Number(line.quantity) || 0);
    if (quantity < 1) {
      throw new Error(`Enter a quantity for "${product.name}"`);
    }
    if (moq > 0 && quantity < moq) {
      throw new Error(
        `"${product.name}" has a minimum order quantity of ${moq.toLocaleString()}`
      );
    }

    const unitPrice = Number(product.price);
    priced.push({
      productId: product.id,
      productName: product.name,
      quantity,
      unitPrice,
      lineTotal: round2(unitPrice * quantity),
      moq,
      currency: product.currency,
      customization: line.customization?.trim() || null,
    });
  }

  const currency = priced[0].currency || factory.default_currency || "USD";
  const subtotal = round2(priced.reduce((sum, l) => sum + l.lineTotal, 0));
  const totalQuantity = priced.reduce((sum, l) => sum + l.quantity, 0);
  const blendedUnitPrice = subtotal / totalQuantity;

  const colorCount = Math.max(1, Math.round(Number(input.colorCount) || 1));
  const plateCost =
    input.plateCost !== undefined && input.plateCost !== null
      ? Number(input.plateCost)
      : Number(factory.plate_cost_default) || 0;

  const rules = await calculateQuote({
    factoryId,
    unitPrice: blendedUnitPrice,
    quantity: totalQuantity,
    currency,
    destinationCountry: input.destinationCountry ?? undefined,
    tradeTerm: input.tradeTerm,
    plateCost,
    colorCount,
    colorFeePerColor: Number(factory.color_fee_default) || 0,
  });

  const discountAmount = round2(subtotal * (rules.discountPercent / 100));
  const total = round2(
    subtotal - discountAmount + rules.totalSetupFees + rules.shippingCost
  );

  return {
    lines: priced,
    currency,
    totalQuantity,
    subtotal,
    discountPercent: rules.discountPercent,
    discountAmount,
    setupFees: rules.totalSetupFees,
    plateCost: rules.plateCost,
    colorFees: rules.colorFees,
    shippingCost: rules.shippingCost,
    tradeTerm: rules.tradeTerm,
    total,
  };
}

/**
 * Persists a customer-submitted cart as a `pending` quotation plus its line
 * items, in one transaction.
 *
 * `quotations.product_id / quantity / unit_price` are populated from the first
 * line so the pre-existing chat + PDF code paths, which read those columns
 * directly, keep working against multi-item quotations.
 */
export async function createQuoteRequest(
  factoryId: string,
  leadId: string,
  input: QuoteRequestInput
) {
  const quote = await priceQuoteRequest(factoryId, input);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const validityRes = await client.query(
      "SELECT quote_validity_days FROM factories WHERE id = $1",
      [factoryId]
    );
    const validityDays = Number(validityRes.rows[0]?.quote_validity_days) || 30;
    const quoteNumber = await nextQuoteNumber(client);
    const first = quote.lines[0];

    const inserted = await client.query(
      `INSERT INTO quotations (
         factory_id, lead_id, product_id, quantity, unit_price,
         discount_percent, discount_amount, shipping_cost, setup_fees,
         subtotal, total_price, currency, status,
         plate_cost, color_count, trade_term,
         quote_number, valid_until, destination_country, customer_notes, source
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8, $9,
         $10, $11, $12, 'pending',
         $13, $14, $15,
         $16, (NOW() + ($17 || ' days')::INTERVAL)::DATE, $18, $19, 'storefront'
       ) RETURNING *`,
      [
        factoryId,
        leadId,
        first.productId,
        first.quantity,
        first.unitPrice,
        quote.discountPercent,
        quote.discountAmount,
        quote.shippingCost,
        quote.setupFees,
        quote.subtotal,
        quote.total,
        quote.currency,
        quote.plateCost,
        Math.max(1, Math.round(Number(input.colorCount) || 1)),
        quote.tradeTerm,
        quoteNumber,
        String(validityDays),
        input.destinationCountry ?? null,
        input.customerNotes?.trim() || null,
      ]
    );

    const quotationId = inserted.rows[0].id;

    for (let i = 0; i < quote.lines.length; i++) {
      const line = quote.lines[i];
      await client.query(
        `INSERT INTO quotation_items (
           quotation_id, product_id, product_name, quantity,
           unit_price, line_total, customization, sort_order
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          quotationId,
          line.productId,
          line.productName,
          line.quantity,
          line.unitPrice,
          line.lineTotal,
          line.customization,
          i,
        ]
      );
    }

    // Requesting a quote promotes a prospect to an active customer.
    await client.query(
      "UPDATE leads SET status = 'active', updated_at = NOW() WHERE id = $1",
      [leadId]
    );

    await client.query("COMMIT");
    return { quotationId, quoteNumber, preview: quote };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
