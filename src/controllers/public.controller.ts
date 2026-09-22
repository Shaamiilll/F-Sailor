import { Request, Response } from "express";
import { findFactoryByUsername, findProductsByFactory, productToResponse } from "../services/db.service";

export async function getFactoryByUsername(req: Request, res: Response) {
  try {
    const factory = await findFactoryByUsername(req.params.username as string);
    if (!factory) {
      res.status(404).json({ error: "Factory not found" });
      return;
    }
    res.json({
      id: factory.id,
      name: factory.name,
      type: factory.type,
      country: factory.country,
      username: factory.username,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getFactoryProducts(req: Request, res: Response) {
  try {
    const factory = await findFactoryByUsername(req.params.username as string);
    if (!factory) {
      res.status(404).json({ error: "Factory not found" });
      return;
    }
    const products = await findProductsByFactory(factory.id);
    const visible = products
      .filter((p) => p.status === "active")
      .map(productToResponse);
    res.json(visible);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
