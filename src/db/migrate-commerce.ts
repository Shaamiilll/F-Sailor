/**
 * Additive migration: turns the single-product quotation store into a full
 * quotation -> order commerce flow.
 *
 * Everything here is idempotent and non-destructive. The n8n / Telegram chat
 * gateway keeps working unchanged: `quotations.product_id/quantity/unit_price`
 * stay populated, and the only constraint touched is the `status` CHECK, which
 * is widened (never narrowed).
 *
 * Run with: npm run db:migrate
 */
import { pool } from "../config/db";

export const commerceSchema = `
-- ---------------------------------------------------------------------------
-- leads double as the customer record: dedup is already (factory_id, email),
-- which is exactly the identity a storefront login needs.
-- ---------------------------------------------------------------------------
ALTER TABLE leads ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'prospect';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notes TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'leads_status_check'
  ) THEN
    ALTER TABLE leads ADD CONSTRAINT leads_status_check
      CHECK (status IN ('prospect', 'active', 'inactive'));
  END IF;
END $$;

-- One customer per email per factory. The same buyer may hold an account at
-- several factories, hence the composite key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_factory_email
  ON leads(factory_id, LOWER(email)) WHERE email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Per-factory tooling defaults. Previously the $50 plate / $20-per-colour fees
-- lived as magic numbers in docs; these make them real, editable settings.
-- ---------------------------------------------------------------------------
ALTER TABLE factories ADD COLUMN IF NOT EXISTS plate_cost_default DECIMAL(12, 4) NOT NULL DEFAULT 0;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS color_fee_default  DECIMAL(12, 4) NOT NULL DEFAULT 0;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS default_currency   VARCHAR(10) NOT NULL DEFAULT 'USD';
ALTER TABLE factories ADD COLUMN IF NOT EXISTS quote_validity_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE factories ADD COLUMN IF NOT EXISTS monthly_mockup_limit INTEGER DEFAULT 50;

-- ---------------------------------------------------------------------------
-- Commercial metadata on quotations
-- ---------------------------------------------------------------------------
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS quote_number        VARCHAR(30);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS valid_until         DATE;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS notes               TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS customer_notes      TEXT;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS destination_country VARCHAR(255);
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS setup_fees          DECIMAL(12, 4) NOT NULL DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS source              VARCHAR(30) NOT NULL DEFAULT 'chatbot';
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS plate_cost          DECIMAL(12, 4) DEFAULT 0;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS color_count         INTEGER DEFAULT 1;
ALTER TABLE quotations ADD COLUMN IF NOT EXISTS trade_term          VARCHAR(20) DEFAULT 'EXW';

CREATE UNIQUE INDEX IF NOT EXISTS idx_quotations_quote_number
  ON quotations(quote_number) WHERE quote_number IS NOT NULL;

-- Widen the status vocabulary: a customer-submitted request lands as 'pending'.
-- Every pre-existing value stays legal.
ALTER TABLE quotations DROP CONSTRAINT IF EXISTS quotations_status_check;
ALTER TABLE quotations ADD CONSTRAINT quotations_status_check
  CHECK (status IN ('draft', 'pending', 'sent', 'approved', 'rejected', 'expired'));

-- ---------------------------------------------------------------------------
-- Line items: a quotation can now hold several products
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS quotation_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  quotation_id UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  product_id   UUID REFERENCES products(id) ON DELETE SET NULL,
  product_name VARCHAR(255) NOT NULL,
  quantity     INTEGER NOT NULL,
  unit_price   DECIMAL(12, 4) NOT NULL,
  line_total   DECIMAL(12, 4) NOT NULL,
  customization TEXT,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotation_items_quotation
  ON quotation_items(quotation_id);

-- ---------------------------------------------------------------------------
-- Orders: created when a factory approves a quotation.
-- Status values deliberately mirror the frontend OrderStatus union so no
-- mapping layer is needed between DB and UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id   UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  lead_id      UUID REFERENCES leads(id) ON DELETE SET NULL,
  quotation_id UUID UNIQUE REFERENCES quotations(id) ON DELETE SET NULL,
  order_number VARCHAR(30) UNIQUE NOT NULL,
  total_price  DECIMAL(12, 4) NOT NULL,
  currency     VARCHAR(10) NOT NULL DEFAULT 'USD',
  status VARCHAR(30) NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('quote', 'accepted', 'payment_pending', 'paid',
                      'production', 'shipped', 'completed')),
  estimated_delivery DATE,
  tracking_number VARCHAR(120),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_factory ON orders(factory_id);
CREATE INDEX IF NOT EXISTS idx_orders_lead ON orders(lead_id);

CREATE TABLE IF NOT EXISTS order_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status VARCHAR(30) NOT NULL,
  note TEXT,
  changed_by VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_order_status_history_order
  ON order_status_history(order_id, created_at);

-- ---------------------------------------------------------------------------
-- Human-readable document numbers (QT-2026-000123 / ORD-2026-000123)
-- ---------------------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS quote_number_seq START 1;
CREATE SEQUENCE IF NOT EXISTS order_number_seq START 1;
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(commerceSchema);

    // Back-fill quote numbers for rows that predate the column.
    const missing = await client.query(
      "SELECT id, created_at FROM quotations WHERE quote_number IS NULL ORDER BY created_at"
    );
    for (const row of missing.rows) {
      const year = new Date(row.created_at).getFullYear();
      const seq = await client.query("SELECT nextval('quote_number_seq') AS n");
      const num = `QT-${year}-${String(seq.rows[0].n).padStart(6, "0")}`;
      await client.query("UPDATE quotations SET quote_number = $1 WHERE id = $2", [num, row.id]);
    }
    if (missing.rows.length > 0) {
      console.log(`Back-filled quote_number on ${missing.rows.length} quotation(s)`);
    }

    await client.query("COMMIT");
    console.log("Commerce migration applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

// Only self-execute when run directly (init.ts imports the schema instead).
if (process.argv[1] && process.argv[1].includes("migrate-commerce")) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error("Migration failed:", err);
      process.exit(1);
    });
}
