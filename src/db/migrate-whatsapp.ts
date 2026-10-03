import { pool } from "../config/db";

/**
 * WhatsApp Business automation.
 *
 * A factory connects its own Meta WhatsApp Business number, and inbound
 * messages get answered automatically from its product catalog.
 *
 * Deliberately NOT a new message store: inbound and outbound messages are
 * written to the existing `chat_sessions` / `chat_messages` tables with an
 * `external_user_id` of `whatsapp:<phone>`, which `inbox.service.detectChannel`
 * already recognises. WhatsApp threads therefore appear in the Conversations
 * inbox next to web chat with no extra work.
 *
 * `whatsapp_conversations` exists for a different reason: Meta bills and
 * rate-limits per 24-hour *conversation window*, not per message, and the free
 * tier is 1,000 service conversations a month. One row per window is what makes
 * that countable.
 */
export const whatsappSchema = `
CREATE TABLE IF NOT EXISTS whatsapp_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL UNIQUE REFERENCES factories(id) ON DELETE CASCADE,

  -- Meta credentials. The phone number id is what inbound webhooks identify
  -- the destination by, so it must be unique across tenants.
  phone_number_id VARCHAR(64) UNIQUE,
  waba_id VARCHAR(64),
  display_phone_number VARCHAR(32),
  -- AES-256-GCM, never returned by the API. See crypto.service.ts.
  access_token_encrypted TEXT,
  app_secret_encrypted TEXT,
  -- Ours, not Meta's: the string Meta echoes back during the webhook handshake.
  verify_token VARCHAR(128) NOT NULL,

  status VARCHAR(20) NOT NULL DEFAULT 'not_connected'
    CHECK (status IN ('not_connected', 'connected', 'error')),
  last_error TEXT,
  last_verified_at TIMESTAMPTZ,

  -- Automation ------------------------------------------------------------
  auto_reply_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ai_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  ai_tone VARCHAR(20) NOT NULL DEFAULT 'professional',
  ai_instructions TEXT NOT NULL DEFAULT '',
  greeting_message TEXT NOT NULL DEFAULT '',
  away_message TEXT NOT NULL DEFAULT '',
  fallback_message TEXT NOT NULL DEFAULT '',
  -- {"timezone":"Asia/Shanghai","enabled":false,"days":{"mon":{"open":"09:00","close":"18:00"}}}
  business_hours JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- A message containing one of these stops the bot and flags a human.
  handover_keywords TEXT[] NOT NULL DEFAULT ARRAY['human', 'agent', 'representative'],
  collect_lead_details BOOLEAN NOT NULL DEFAULT TRUE,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_configs_phone ON whatsapp_configs(phone_number_id);

-- One row per 24-hour Meta conversation window, which is the unit Meta counts.
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  factory_id UUID NOT NULL REFERENCES factories(id) ON DELETE CASCADE,
  session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  wa_contact_id VARCHAR(32) NOT NULL,
  contact_name VARCHAR(255),
  opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Meta's free-form reply window. Past this, only templates may be sent.
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  inbound_count INTEGER NOT NULL DEFAULT 0,
  outbound_count INTEGER NOT NULL DEFAULT 0,
  -- Set when a human takes over; the bot stays quiet on this thread.
  handover BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_factory
  ON whatsapp_conversations(factory_id, opened_at DESC);

-- Finding the open window for a contact is the hot path on every inbound
-- message, so it gets its own partial index.
CREATE INDEX IF NOT EXISTS idx_whatsapp_conversations_open
  ON whatsapp_conversations(factory_id, wa_contact_id, expires_at);

-- Meta retries a webhook it believes failed. Recording the message id makes a
-- redelivery a no-op rather than a second auto-reply to the same question.
CREATE TABLE IF NOT EXISTS whatsapp_inbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wa_message_id VARCHAR(128) NOT NULL UNIQUE,
  factory_id UUID REFERENCES factories(id) ON DELETE CASCADE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(whatsappSchema);
    await client.query("COMMIT");
    console.log("WhatsApp migration applied successfully");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

if (process.argv[1] && process.argv[1].includes("migrate-whatsapp")) {
  migrate()
    .then(() => pool.end())
    .catch((err) => {
      console.error("WhatsApp migration failed:", err);
      process.exit(1);
    });
}
