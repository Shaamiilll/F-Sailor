/**
 * Plan *types* and the seed catalog.
 *
 * The live catalog lives in the `plans` table and is managed by an admin --
 * see plan.service.ts. What's here is the shape of a plan plus the three tiers
 * the database is seeded with on first run, so a fresh install has a working
 * price list before anyone opens the admin panel.
 *
 * Nothing in the app should read DEFAULT_PLANS to make a decision at runtime;
 * read the database, or an admin's edits would have no effect.
 */

export type BillingInterval = "monthly" | "annual";

export interface PlanInput {
  /** Stable, URL-safe identifier. Stored on `factories.plan`. */
  code: string;
  /** Short tier label shown above the plan name, e.g. "Growth". */
  tier: string;
  name: string;
  tagline: string;
  monthlyPrice: number;
  annualPrice: number;
  /** How many channels (website widget, WhatsApp, Telegram...) may be active. */
  channelLimit: number;
  /** AI logo mockups this plan allows per calendar month. */
  monthlyMockupLimit: number;
  /** The channel-limit wording shown on the pricing page. */
  channelNote: string;
  features: string[];
  targetBuyer: string;
  popular: boolean;
  sortOrder: number;
  active: boolean;
}

export interface Plan extends PlanInput {
  id: string;
  stripeProductId: string | null;
  stripeMonthlyPriceId: string | null;
  stripeAnnualPriceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function isBillingInterval(value: unknown): value is BillingInterval {
  return value === "monthly" || value === "annual";
}

export function priceForInterval(plan: PlanInput, interval: BillingInterval): number {
  return interval === "annual" ? plan.annualPrice : plan.monthlyPrice;
}

/** Seeded into the `plans` table the first time the billing migration runs. */
export const DEFAULT_PLANS: PlanInput[] = [
  {
    code: "starter",
    tier: "Starter",
    name: "The Solo Exporter",
    tagline: "For small export desks managing one primary web presence.",
    monthlyPrice: 30,
    annualPrice: 300,
    channelLimit: 1,
    monthlyMockupLimit: 200,
    channelNote: "1 active channel — Website Chat Widget only",
    features: [
      "24/7 AI sales agent that responds instantly to international inquiries",
      "Direct integration with product catalogs, including MOQ, materials, sizing, and pricing",
      "Automated PDF quotation generation",
      "Owner approval workflow through Telegram or email",
    ],
    targetBuyer:
      "Single-product niche exporters or small factory owners testing automation to capture late-night overseas inquiries.",
    popular: false,
    sortOrder: 1,
    active: true,
  },
  {
    code: "growth",
    tier: "Growth",
    name: "The Multi-Channel Supplier",
    tagline: "For growing export teams managing multiple customer touchpoints.",
    monthlyPrice: 50,
    annualPrice: 500,
    channelLimit: 2,
    monthlyMockupLimit: 500,
    channelNote: "2 active channels — e.g. Website Chat Widget + WhatsApp Business API",
    features: [
      "Everything in Starter",
      "Cross-channel conversation memory",
      "Priority quote-generation routing",
      "Advanced multi-factory ID separation",
      "Structured lead logging: name, company, email, country, and requirements summary",
    ],
    targetBuyer:
      "Mid-sized packaging or custom printing factories whose overseas sales managers rely on WhatsApp and need a centralized way to handle high-volume buyer chats.",
    popular: true,
    sortOrder: 2,
    active: true,
  },
  {
    code: "scale",
    tier: "Scale",
    name: "The Global Operation",
    tagline:
      "For established manufacturers requiring broader coverage and operational support.",
    monthlyPrice: 100,
    annualPrice: 1000,
    channelLimit: 3,
    monthlyMockupLimit: 800,
    channelNote: "3 active channels — Website Chat + WhatsApp + Telegram or custom integrations",
    features: [
      "Everything in Growth, with top-tier system priority",
      "Custom landing-page optimization guidance and setup assistance for international buyers",
      "Instant chat handover protocols",
      "Dedicated system support",
    ],
    targetBuyer:
      "Large-scale custom manufacturers, such as corrugated box plants and large apparel exporters, managing substantial international inquiry volumes and factory approval gates.",
    popular: false,
    sortOrder: 3,
    active: true,
  },
];

/** The plan a factory falls back to when nothing else is specified. */
export const FALLBACK_PLAN_CODE = "starter";
