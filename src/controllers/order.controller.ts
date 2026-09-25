import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as orderService from "../services/order.service";

export async function listOrders(req: AuthRequest, res: Response) {
  try {
    res.json(await orderService.listOrders(req.user!.factoryId!));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getOrder(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const id = req.params.id as string;
    const order = await orderService.getOrder(factoryId, id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const history = await orderService.getOrderStatusHistory(factoryId, id);
    res.json({ order, history });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function updateOrderStatus(req: AuthRequest, res: Response) {
  try {
    const { status, note } = req.body;
    if (!status) {
      res.status(400).json({ error: "Status is required" });
      return;
    }
    const order = await orderService.updateOrderStatus(
      req.user!.factoryId!,
      req.params.id as string,
      status,
      note,
      req.user!.email
    );
    const history = await orderService.getOrderStatusHistory(
      req.user!.factoryId!,
      order.id
    );
    res.json({ order, history });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message === "Order not found" ? 404 : 400).json({ error: message });
  }
}

export async function updateOrder(req: AuthRequest, res: Response) {
  try {
    const order = await orderService.updateOrder(
      req.user!.factoryId!,
      req.params.id as string,
      req.body
    );
    res.json({ order });
  } catch (err) {
    const message = (err as Error).message;
    res.status(message === "Order not found" ? 404 : 400).json({ error: message });
  }
}
