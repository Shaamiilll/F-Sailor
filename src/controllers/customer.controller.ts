import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as customerService from "../services/customer.service";

export async function listCustomers(req: AuthRequest, res: Response) {
  try {
    res.json(await customerService.listCustomers(req.user!.factoryId!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getCustomer(req: AuthRequest, res: Response) {
  try {
    const detail = await customerService.getCustomerDetail(
      req.user!.factoryId!,
      req.params.id as string
    );
    if (!detail) {
      res.status(404).json({ error: "Customer not found" });
      return;
    }
    res.json(detail);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function updateCustomer(req: AuthRequest, res: Response) {
  try {
    const updated = await customerService.updateCustomer(
      req.user!.factoryId!,
      req.params.id as string,
      req.body
    );
    res.json(updated);
  } catch (err) {
    const message = (err as Error).message;
    res.status(message === "Customer not found" ? 404 : 400).json({ error: message });
  }
}
