import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { env } from "../config/env";
import { commerceSchema } from "./migrate-commerce";

const schema = `
CREATE TABLE IF NOT EXISTS factories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(255) NOT NULL DEFAULT '',
  country VARCHAR(255) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50) NOT NULL DEFAULT '',
  username VARCHAR(63) UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('admin', 'factory')),
  factory_id UUID REFERENCES factories(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(255) NOT NULL,
  specification TEXT NOT NULL DEFAULT '',
  capacity VARCHAR(100),
  material VARCHAR(255),
  dimensions VARCHAR(255),
  gsm VARCHAR(50),
  wall_type VARCHAR(100),
  printing_method VARCHAR(100),
  moq INTEGER NOT NULL DEFAULT 0,
  price DECIMAL(12, 4) NOT NULL DEFAULT 0,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  lead_time VARCHAR(100) NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'draft')),
  size VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_products_factory_id ON products(factory_id);
CREATE INDEX IF NOT EXISTS idx_users_factory_id ON users(factory_id);
-- Leads: a potential customer captured by the chatbot
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  company VARCHAR(255),
  country VARCHAR(255),
  source VARCHAR(50) NOT NULL DEFAULT 'chatbot',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Chat sessions: lets the bot recognize a returning visitor
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  external_user_id VARCHAR(255) NOT NULL, -- id n8n/whatsapp/webchat uses to identify the visitor
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_external_user
  ON chat_sessions(factory_id, external_user_id);

-- Chat messages: the actual conversation history
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL CHECK (role IN ('user', 'bot')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Discount tiers: "if quantity >= X, apply Y% off" -- fully editable per factory
CREATE TABLE IF NOT EXISTS discount_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  min_quantity INTEGER NOT NULL,
  discount_percent DECIMAL(5, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_discount_tiers_factory ON discount_tiers(factory_id);

-- Shipping rates: flat / per-unit / per-kg, editable per factory (and optionally per country)
CREATE TABLE IF NOT EXISTS shipping_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  destination_country VARCHAR(255), -- NULL = default/fallback rate for any country
  rate_type VARCHAR(20) NOT NULL CHECK (rate_type IN ('flat', 'per_unit', 'per_kg')),
  rate_value DECIMAL(12, 4) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shipping_rates_factory ON shipping_rates(factory_id);

-- Quotations: a saved price quote, with a SNAPSHOT of the price at that moment
-- (so if the factory later changes the product's price, old quotes don't change)
CREATE TABLE IF NOT EXISTS quotations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  product_id UUID REFERENCES products(id) ON DELETE SET NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(12, 4) NOT NULL,
  discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12, 4) NOT NULL DEFAULT 0,
  shipping_cost DECIMAL(12, 4) NOT NULL DEFAULT 0,
  subtotal DECIMAL(12, 4) NOT NULL,
  total_price DECIMAL(12, 4) NOT NULL,
  currency VARCHAR(10) NOT NULL DEFAULT 'USD',
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'approved', 'rejected')),
  pdf_url VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_quotations_factory ON quotations(factory_id);
CREATE INDEX IF NOT EXISTS idx_quotations_lead ON quotations(lead_id);

-- Mockups: logo-on-product images generated for a lead
CREATE TABLE IF NOT EXISTS mockups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  logo_url VARCHAR(500) NOT NULL,
  generated_image_url VARCHAR(500),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mockups_factory ON mockups(factory_id);
CREATE INDEX IF NOT EXISTS idx_mockups_product ON mockups(product_id);

-- Needed for mockups (a base photo of the product) and for branded PDFs
-- (the factory's logo). Neither existed in the original schema.
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url VARCHAR(500);
ALTER TABLE factories ADD COLUMN IF NOT EXISTS logo_url VARCHAR(500);

-- Username doubles as the factory's subdomain (e.g. acme.factoryflow.com).
-- Added after the original schema, so older rows may not have one yet.
ALTER TABLE factories ADD COLUMN IF NOT EXISTS username VARCHAR(63) UNIQUE;
`;

async function init() {
  const client = await pool.connect();
  try {
    await client.query(schema);
    // Quotation items, orders, customer logins and document numbering.
    await client.query(commerceSchema);

    const adminCheck = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [env.adminEmail]
    );

    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash(env.adminPassword, 10);
      await client.query(
        `INSERT INTO users (email, password_hash, role) VALUES ($1, $2, 'admin')`,
        [env.adminEmail, hash]
      );
      console.log(`Admin user created: ${env.adminEmail}`);
    } else {
      console.log("Admin user already exists");
    }

    console.log("Database initialized successfully");
  } finally {
    client.release();
    await pool.end();
  }
}

init().catch((err) => {
  console.error("Database init failed:", err);
  process.exit(1);
});
