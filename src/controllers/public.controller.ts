import { Request, Response } from "express";
import {
  findFactoryByUsername,
  findProductsByFactory,
  productToResponse,
} from "../services/db.service";
import { AuthRequest } from "../middleware/auth.middleware";
import * as customerAuth from "../services/customer-auth.service";
import * as quoteRequest from "../services/quote-request.service";
import * as quotationView from "../services/quotation-view.service";
import * as orderService from "../services/order.service";
import { generateQuotationPdf } from "../services/quote.service";

/**
 * Resolves the factory a storefront request is for. Every public route is
 * addressed by `:username` (the subdomain), never by a raw factory id, so a
 * visitor can only ever reach a published storefront.
 */
async function resolveFactory(username: string) {
  const factory = await findFactoryByUsername(username);
  if (!factory) throw new Error("Factory not found");
  return factory;
}

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
      logoUrl: (factory as any).logoUrl ?? null,
      email: factory.email,
      phone: factory.phone,
      currency: (factory as any).default_currency ?? "USD",
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getFactoryProducts(req: Request, res: Response) {
  try {
    const factory = await resolveFactory(req.params.username as string);
    const products = await findProductsByFactory(factory.id);
    res.json(products.filter((p) => p.status === "active").map(productToResponse));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

export async function getFactoryProduct(req: Request, res: Response) {
  try {
    const factory = await resolveFactory(req.params.username as string);
    const products = await findProductsByFactory(factory.id);
    const product = products.find(
      (p) => p.id === req.params.id && p.status === "active"
    );
    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }
    res.json(productToResponse(product));
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
}

/** Live cart pricing. Runs the real pricing engine but persists nothing. */
export async function previewQuote(req: Request, res: Response) {
  try {
    const factory = await resolveFactory(req.params.username as string);
    const preview = await quoteRequest.priceQuoteRequest(factory.id, req.body);
    res.json(preview);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

// --- Customer accounts -------------------------------------------------------

export async function registerCustomer(req: Request, res: Response) {
  try {
    const factory = await resolveFactory(req.params.username as string);
    const { name, email, password, company, phone, country } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: "Name, email and password are required" });
      return;
    }
    const result = await customerAuth.registerCustomer(factory.id, {
      name,
      email,
      password,
      company,
      phone,
      country,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function loginCustomer(req: Request, res: Response) {
  try {
    const factory = await resolveFactory(req.params.username as string);
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }
    const result = await customerAuth.loginCustomer(factory.id, email, password);
    res.json(result);
  } catch (err) {
    res.status(401).json({ error: (err as Error).message });
  }
}

// --- Customer portal (requires a customer token) ------------------------------

export async function getMe(req: AuthRequest, res: Response) {
  try {
    const profile = await customerAuth.getCustomerProfile(
      req.user!.factoryId!,
      req.user!.leadId!
    );
    if (!profile) {
      res.status(404).json({ error: "Account not found" });
      return;
    }
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function submitQuoteRequest(req: AuthRequest, res: Response) {
  try {
    const result = await quoteRequest.createQuoteRequest(
      req.user!.factoryId!,
      req.user!.leadId!,
      req.body
    );
    const quotation = await quotationView.getQuotationForLead(
      req.user!.factoryId!,
      req.user!.leadId!,
      result.quotationId
    );
    res.status(201).json(quotation);
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
}

export async function listMyQuotations(req: AuthRequest, res: Response) {
  try {
    res.json(
      await quotationView.listQuotationsForLead(req.user!.factoryId!, req.user!.leadId!)
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getMyQuotation(req: AuthRequest, res: Response) {
  try {
    const quotation = await quotationView.getQuotationForLead(
      req.user!.factoryId!,
      req.user!.leadId!,
      req.params.id as string
    );
    if (!quotation) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }
    res.json(quotation);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

/** Renders (or re-renders) the buyer's own quotation PDF and returns its path. */
export async function getMyQuotationPdf(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const owned = await quotationView.getQuotationForLead(
      factoryId,
      req.user!.leadId!,
      req.params.id as string
    );
    if (!owned) {
      res.status(404).json({ error: "Quotation not found" });
      return;
    }
    const { pdfUrl } = await generateQuotationPdf(factoryId, owned.id);
    res.json({ pdfUrl });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function listMyOrders(req: AuthRequest, res: Response) {
  try {
    res.json(
      await orderService.listOrdersForLead(req.user!.factoryId!, req.user!.leadId!)
    );
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}

export async function getMyOrderTimeline(req: AuthRequest, res: Response) {
  try {
    const factoryId = req.user!.factoryId!;
    const orders = await orderService.listOrdersForLead(factoryId, req.user!.leadId!);
    const order = orders.find((o) => o.id === req.params.id);
    if (!order) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    const history = await orderService.getOrderStatusHistory(factoryId, order.id);
    res.json({ order, history });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
}
