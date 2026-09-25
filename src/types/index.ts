// "customer" is a storefront buyer. Buyers live in `leads`, not `users`, so
// this role only ever appears inside a JWT -- never in users.role.
export type UserRole = "admin" | "factory" | "customer";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  role: UserRole;
  factoryId: string | null;
  createdAt: Date;
}

export interface Factory {
  id: string;
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  username: string | null;
  createdAt: Date;
}

export type ProductStatus = "active" | "inactive" | "draft";

export interface Product {
  id: string;
  factoryId: string;
  name: string;
  category: string;
  specification: string;
  capacity: string | null;
  material: string | null;
  dimensions: string | null;
  gsm: string | null;
  wallType: string | null;
  printingMethod: string | null;
  moq: number;
  price: number;
  currency: string;
  leadTime: string;
  description: string;
  status: ProductStatus;
  size: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  factoryId: string | null;
  // Set only on customer tokens: the `leads` row this buyer is.
  leadId?: string | null;
}

export interface CreateFactoryInput {
  name: string;
  type: string;
  country: string;
  email: string;
  phone: string;
  password: string;
  username: string;
}

export interface CreateProductInput {
  name: string;
  category: string;
  specification?: string;
  capacity?: string;
  material?: string;
  dimensions?: string;
  gsm?: string;
  wallType?: string;
  printingMethod?: string;
  moq: number;
  price: number;
  currency?: string;
  leadTime: string;
  description?: string;
  status?: ProductStatus;
  size?: string;
}

export interface UpdateProductInput extends Partial<CreateProductInput> {}
// Add these to their existing src/types/index.ts (append at the end)

export interface Lead {
  id: string;
  factoryId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  country: string | null;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChatSession {
  id: string;
  factoryId: string;
  leadId: string | null;
  externalUserId: string;
  createdAt: Date;
  lastActiveAt: Date;
}

export type ChatMessageRole = "user" | "bot";

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: Date;
}

export interface DiscountTier {
  id: string;
  factoryId: string;
  minQuantity: number;
  discountPercent: number;
}

export type ShippingRateType = "flat" | "per_unit" | "per_kg";

export interface ShippingRate {
  id: string;
  factoryId: string;
  destinationCountry: string | null;
  rateType: ShippingRateType;
  rateValue: number;
}

export type QuotationStatus =
  | "draft"
  | "pending"
  | "sent"
  | "approved"
  | "rejected"
  | "expired";

export interface Quotation {
  id: string;
  factoryId: string;
  leadId: string | null;
  productId: string | null;
  quantity: number;
  unitPrice: number;
  discountPercent: number;
  discountAmount: number;
  shippingCost: number;
  subtotal: number;
  totalPrice: number;
  currency: string;
  status: QuotationStatus;
  pdfUrl: string | null;
  createdAt: Date;
}

export interface Mockup {
  id: string;
  factoryId: string;
  leadId: string | null;
  productId: string;
  logoUrl: string;
  generatedImageUrl: string | null;
  createdAt: Date;
}

// --- Commerce: multi-item quotations and the orders they become ---------------

export interface QuotationItem {
  id: string;
  quotationId: string;
  productId: string | null;
  productName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  customization: string | null;
  sortOrder: number;
}

export type OrderStatus =
  | "quote"
  | "accepted"
  | "payment_pending"
  | "paid"
  | "production"
  | "shipped"
  | "completed";

export const ORDER_STATUSES: OrderStatus[] = [
  "quote",
  "accepted",
  "payment_pending",
  "paid",
  "production",
  "shipped",
  "completed",
];

export interface Order {
  id: string;
  factoryId: string;
  leadId: string | null;
  quotationId: string | null;
  orderNumber: string;
  totalPrice: number;
  currency: string;
  status: OrderStatus;
  estimatedDelivery: string | null;
  trackingNumber: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderStatusHistoryEntry {
  id: string;
  orderId: string;
  status: OrderStatus;
  note: string | null;
  changedBy: string | null;
  createdAt: Date;
}

export type CustomerStatus = "prospect" | "active" | "inactive";

/** A line the storefront cart submits. */
export interface QuoteRequestLine {
  productId: string;
  quantity: number;
  customization?: string | null;
}

export interface QuoteRequestInput {
  lines: QuoteRequestLine[];
  tradeTerm?: string;
  destinationCountry?: string | null;
  colorCount?: number;
  plateCost?: number;
  customerNotes?: string | null;
}
