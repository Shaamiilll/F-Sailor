import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as adminService from "../services/admin.service";

const USERNAME_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/;
const RESERVED_USERNAMES = new Set([
  "www",
  "app",
  "api",
  "admin",
  "dashboard",
  "store",
  "login",
  "mail",
  "ftp",
  "static",
  "cdn",
]);

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
    const { name, type, country, email, phone, password, username } = req.body;

    if (!name || !email || !password || !username) {
      res
        .status(400)
        .json({ error: "Name, email, password, and username are required" });
      return;
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    if (!USERNAME_REGEX.test(normalizedUsername)) {
      res.status(400).json({
        error:
          "Username must be 3-32 characters, lowercase letters, numbers, and hyphens only, and can't start or end with a hyphen",
      });
      return;
    }
    if (RESERVED_USERNAMES.has(normalizedUsername)) {
      res.status(400).json({ error: "That username is reserved" });
      return;
    }

    const result = await adminService.createFactory({
      name,
      type: type || "",
      country: country || "",
      email,
      phone: phone || "",
      password,
      username: normalizedUsername,
    });

    res.status(201).json(result);
  } catch (err) {
    const message = (err as Error).message;
    if (message.includes("duplicate") || message.includes("unique")) {
      if (message.includes("username")) {
        res.status(409).json({ error: "Username already taken" });
        return;
      }
      res.status(409).json({ error: "Email already exists" });
      return;
    }
    res.status(500).json({ error: message });
  }
}
