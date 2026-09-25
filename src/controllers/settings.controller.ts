import { Response } from "express";
import { AuthRequest } from "../middleware/auth.middleware";
import * as settings from "../services/settings.service";

export async function getSettings(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const [factory, discountTiers, shippingRates] = await Promise.all([
      settings.getFactorySettings(factoryId),
      settings.listDiscountTiers(factoryId),
      settings.listShippingRates(factoryId),
    ]);
    res.json({ factory, discountTiers, shippingRates });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function updateFactory(req: AuthRequest, res: Response) {
  try {
    res.json(await settings.updateFactorySettings(req.user!.factoryId!, req.body));
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function createDiscountTier(req: AuthRequest, res: Response) {
  try {
    const { minQuantity, discountPercent } = req.body;
    res.status(201).json(
      await settings.createDiscountTier(req.user!.factoryId!, minQuantity, discountPercent)
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function deleteDiscountTier(req: AuthRequest, res: Response) {
  try {
    await settings.deleteDiscountTier(req.user!.factoryId!, req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function createShippingRate(req: AuthRequest, res: Response) {
  try {
    const { destinationCountry, rateType, rateValue } = req.body;
    res.status(201).json(
      await settings.createShippingRate(
        req.user!.factoryId!,
        destinationCountry ?? null,
        rateType,
        rateValue
      )
    );
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function deleteShippingRate(req: AuthRequest, res: Response) {
  try {
    await settings.deleteShippingRate(req.user!.factoryId!, req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}
