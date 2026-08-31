import bcrypt from "bcryptjs";
import { pool } from "../config/db";
import { env } from "../config/env";

const schema = `
CREATE TABLE IF NOT EXISTS factories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  type VARCHAR(255) NOT NULL DEFAULT '',
  country VARCHAR(255) NOT NULL DEFAULT '',
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(50) NOT NULL DEFAULT '',
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
`;

async function init() {
  const client = await pool.connect();
  try {
    await client.query(schema);

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
