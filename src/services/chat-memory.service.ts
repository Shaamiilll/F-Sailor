import { pool } from "../config/db";

export async function getOrCreateSession(
  factoryId: string,
  externalUserId: string,
  leadId?: string
) {
  const client = await pool.connect();
  try {
    // 1. Check if session already exists for this factory and user
    const existing = await client.query(
      `SELECT * FROM chat_sessions 
       WHERE factory_id = $1 AND external_user_id = $2 
       LIMIT 1`,
      [factoryId, externalUserId]
    );

    if (existing.rows.length > 0) {
      // Update last_active_at
      await client.query(
        `UPDATE chat_sessions SET last_active_at = NOW() WHERE id = $1`,
        [existing.rows[0].id]
      );
      return existing.rows[0];
    }

    // 2. Otherwise create a new session
    const created = await client.query(
      `INSERT INTO chat_sessions (factory_id, external_user_id, lead_id)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [factoryId, externalUserId, leadId || null]
    );

    return created.rows[0];
  } finally {
    client.release();
  }
}

export async function saveChatMessage(
  factoryId: string,
  externalUserId: string,
  role: "user" | "bot",
  content: string,
  leadId?: string
) {
  const session = await getOrCreateSession(factoryId, externalUserId, leadId);
  const client = await pool.connect();
  try {
    const result = await client.query(
      `INSERT INTO chat_messages (session_id, role, content)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [session.id, role, content]
    );
    return result.rows[0];
  } finally {
    client.release();
  }
}

export async function getChatHistory(
  factoryId: string,
  externalUserId: string,
  limit: number = 20
) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT m.role, m.content, m.created_at
       FROM chat_messages m
       JOIN chat_sessions s ON m.session_id = s.id
       WHERE s.factory_id = $1 AND s.external_user_id = $2
       ORDER BY m.created_at ASC
       LIMIT $3`,
      [factoryId, externalUserId, limit]
    );
    return result.rows;
  } finally {
    client.release();
  }
}