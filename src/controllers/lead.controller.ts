import { Response } from "express";
import { ChatRequest } from "../middleware/chat.middleware";
import * as leadService from "../services/lead.service";

export async function saveLead(req: ChatRequest, res: Response) {
  try {
    const { name, email, phone, company, country, notes, source } = req.body;

    const lead = await leadService.createOrUpdateLead(req.factoryId!, {
      name,
      email,
      phone,
      company,
      country,
      notes,
      source,
    });

    res.status(201).json(lead);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}