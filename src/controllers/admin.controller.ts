import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as adminService from "../services/admin.service";

export async function listFactories(req: AuthRequest, res: Response) {
  try {
    const factories = await adminService.listFactories();
    res.json(factories);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function createFactory(req: AuthRequest, res: Response) {
  try {
    const { name, type, country, email, phone, password } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ error: "Name, email, and password are required" });
      return;
    }

    const result = await adminService.createFactory({
      name,
      type: type || "",
      country: country || "",
      email,
      phone: phone || "",
      password,
    });

    res.status(201).json(result);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("duplicate") || message.includes("unique")) {
      res.status(409).json({ error: "Email already exists" });
      return;
    }
    res.status(500).json({ error: message });
  }
}
