import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as productService from "../services/product.service";

export async function listProducts(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const products = await productService.listProducts(factoryId);
    res.json(products);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getProduct(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const id = req.params.id as string;
    const product = await productService.getProduct(factoryId, id);
    res.json(product);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function createProduct(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const { name, category, moq, price, leadTime } = req.body;

    if (!name || !category || moq === undefined || price === undefined || !leadTime) {
      res.status(400).json({
        error: "Name, category, MOQ, price, and lead time are required",
      });
      return;
    }

    const product = await productService.addProduct(factoryId, req.body);
    res.status(201).json(product);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function updateProduct(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const id = req.params.id as string;
    const product = await productService.editProduct(
      factoryId,
      id,
      req.body
    );
    res.json(product);
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function deleteProduct(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const id = req.params.id as string;
    await productService.removeProduct(factoryId, id);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}
