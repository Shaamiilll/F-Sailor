import { pool } from "../config/db";

export interface LeadData {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  company?: string | null;
  country?: string | null;
  notes?: string | null;
  source?: string;
}

export async function createOrUpdateLead(factoryId: string, data: LeadData) {
  const client = await pool.connect();
  try {
    // 1. If email is provided, check if lead already exists for this factory
    if (data.email) {
      const existing = await client.query(
        `SELECT * FROM leads WHERE factory_id = $1 AND LOWER(email) = LOWER($2) LIMIT 1`,
        [factoryId, data.email.trim()]
      );

      if (existing.rows.length > 0) {
        const leadId = existing.rows[0].id;
        const currentNotes = existing.rows[0].notes || "";
        
        // Append new notes to existing notes if they differ
        let combinedNotes = currentNotes;
        if (data.notes && !currentNotes.includes(data.notes)) {
          combinedNotes = currentNotes ? `${currentNotes}\n---\n${data.notes}` : data.notes;
        }

        const updated = await client.query(
          `UPDATE leads 
           SET name = COALESCE($1, name),
               phone = COALESCE($2, phone),
               company = COALESCE($3, company),
               country = COALESCE($4, country),
               notes = $5,
               updated_at = NOW()
           WHERE id = $6
           RETURNING *`,
          [
            data.name || null,
            data.phone || null,
            data.company || null,
            data.country || null,
            combinedNotes,
            leadId,
          ]
        );
        return updated.rows[0];
      }
    }

    // 2. Otherwise, create a brand new lead
    const created = await client.query(
      `INSERT INTO leads (factory_id, name, email, phone, company, country, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        factoryId,
        data.name || null,
        data.email ? data.email.trim().toLowerCase() : null,
        data.phone || null,
        data.company || null,
        data.country || null,
        data.notes || null,
        data.source || "chatbot",
      ]
    );

    return created.rows[0];
  } finally {
    client.release();
  }
}

export async function findLeadById(leadId: string, factoryId: string) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT * FROM leads WHERE id = $1 AND factory_id = $2`,
      [leadId, factoryId]
    );
    return result.rows[0] || null;
  } finally {
    client.release();
  }
}