import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as dashboard from "../services/dashboard.service";
import * as quotationView from "../services/quotation-view.service";
import * as orderService from "../services/order.service";

export async function getStats(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const [stats, quotations, orders] = await Promise.all([
      dashboard.getStats(factoryId),
      quotationView.listQuotationsForFactory(factoryId),
      orderService.listOrders(factoryId),
    ]);
    res.json({
      stats,
      recentQuotations: quotations.slice(0, 5),
      recentOrders: orders.slice(0, 5),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getAnalytics(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const days = Number(req.query.days) || 30;
    const [series, funnel, stats] = await Promise.all([
      dashboard.getAnalytics(factoryId, days),
      dashboard.getFunnel(factoryId),
      dashboard.getStats(factoryId),
    ]);
    res.json({ series, funnel, stats });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
