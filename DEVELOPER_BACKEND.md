# Backend Architecture & API Integration Guide

**Author:** Aeraj Fatima — AI & Backend Solutions Engineer  
**Scope:** PostgreSQL Migrations, Industrial Pricing Engine, Document Compilation, Multi-Tenancy Gateway, and Quota Management  
**Environment:** Node.js / TypeScript / Express / PostgreSQL / Render  

---

## 1. Architectural Overview & Multi-Tenant Gateway

To support autonomous, multi-channel B2B quotation generation, an isolated, multi-tenant API layer was engineered to integrate seamlessly with the Node.js and PostgreSQL backend.

### Non-Breaking System Guarantee
* Pre-existing core endpoints—including `/api/auth`, `/api/admin`, and `/api/products`—remain 100% intact, untouched, and fully backward-compatible.
* Conversational, quoting, and memory features operate under the dedicated `/api/chat` namespace.
* Multi-tenancy is enforced at the gateway layer via the `x-factory-id` header, guaranteeing zero data leakage between separate manufacturing plants.
* Factory-dashboard approval features operate under the dedicated `/api/quotations` namespace, secured by standard JWT login rather than the `x-factory-id` header — no existing endpoint, route, or automation gateway was modified to add this layer.

---

## 2. PostgreSQL Database Migrations & Schemas

The following non-destructive extensions and schemas were added to the primary database:

### A. Non-Destructive Table Alterations (`ALTER TABLE`)
- `products.image_url`: VARCHAR(500) storing high-resolution template photos.
- `factories.logo_url`: VARCHAR(500) for vector-sharp PDF header rendering.
- `factories.monthly_mockup_limit`: INTEGER (default 50) for factory-specific monthly API quota management.
- `leads.notes`: TEXT storing persistent customer specifications, order history, and conversational memory.
- `quotations.plate_cost`: DECIMAL(12, 4) tracking one-time tooling and screen setup fees.
- `quotations.color_count`: INTEGER tracking multi-color print passes.
- `quotations.trade_term`: VARCHAR(20) tracking Incoterms (EXW vs. FOB).

### B. Core Tables Added for B2B Operations
1. `quotations`: Stores immutable price snapshots, applied volume discounts, freight costs, setup fees, trade terms, and compiled PDF URLs. The existing `status` column (`draft` / `sent` / `approved` / `rejected`) is now also updatable via the factory dashboard gateway described in Section 3G, in addition to its original lifecycle writes.
2. `discount_tiers`: Factory-specific volume discount rules (e.g., 5% off at 2,500 units, 10% off at 5,000 units).
3. `shipping_rates`: Configurable freight rules per factory and destination country.
4. `mockups`: Storage of rendered product visuals linked to customer artwork.
5. `chat_sessions` & `chat_messages`: PostgreSQL-backed session persistence for multi-turn conversational memory. `chat_sessions` is additionally used to persist which factory a returning Telegram/WhatsApp user belongs to across messages.
6. `n8n_chat_histories`: LangChain-compatible conversation buffer.

---

## 3. Backend Micro-Services Inventory (`src/`)

### A. Industrial Pricing Engine (`src/services/pricing.service.ts`)
Calculates manufacturing landed costs deterministically via code rather than probabilistic AI estimates:
Grand Total = (Base Price + Add-ons) * Quantity * (1 - Discount) + Setup Fees + Freight

* Strict Type Sanitization: Uses defensive number coercion to prevent floating-point or string-concatenation errors.
* Plate / Screen Tooling Fees: One-time setup fee per production run (default $50.00).
* Multi-Color Printing: Incremental fee for complex artwork (default $20.00 per additional color beyond 1).
* Component Add-ons: Per-unit accessories (e.g., biodegradable PLA lids at +$0.03/unit).
* Incoterms / Trade Terms: 
  - EXW (Ex-Works / Factory Gate): Customer arranges pickup ($0 freight).
  - FOB (Free On Board): Local port drayage and seaport delivery handling ($75 flat).
  - DDP: International door-to-door delivery derived from `shipping_rates`.

### B. Quotation Lifecycle & Resilience Engine (`src/services/quote.service.ts`)
* Foreign Key Defense: Validates whether an incoming `leadId` exists in the database. If an unverified, fake, or null identifier is passed, it safely falls back to `NULL` to prevent foreign key constraint violations (`22P02`).
* Lead Auto-Linking: If a quote request omits `leadId`, the service automatically links the quote to the most recent customer record created for that factory.
* Granular Persistence: Persists `plate_cost`, `color_count`, and `trade_term` into distinct database columns for clean admin dashboard inspection.
* Status Transition Function: `updateQuotationStatus(factoryId, id, status)` performs a factory-scoped `UPDATE` against the existing `status` column, restricted to `'approved'` or `'rejected'`. It is consumed exclusively by the dashboard gateway in Section 3G and does not alter the existing `createQuotation` or `generateQuotationPdf` flows.

### C. Universal Product Resolver (`src/services/db.service.ts`)
The `findProductById` function implements an anti-crash lookup pipeline:
1. UUID Primary Key Lookup: Checks RFC4122 regex; queries by primary key if valid.
2. Exact & Partial Name Matching: Matches human-readable product names.
3. Keyword Tokenizer: Splits strings into tokens (e.g., matching `"12oz"`, `"single"`, `"wall"`, `"cup"` regardless of word order).
4. Auto-Generated Telegram Launch Links: The `mapFactory` helper automatically appends `telegramBotUrl` (`https://t.me/<bot>?start=<factory_id>`) to all factory records so admin dashboards can render direct Telegram redirect buttons.

### D. Lead Management & Deduplication (`src/services/lead.service.ts`)
* Implements an intelligent upsert pattern based on customer email.
* If an existing customer inquires again, their profile is updated and fresh order requirements are appended to the `notes` column rather than duplicating customer rows.

### E. Programmatic PDF Document Generator (`src/services/pdf.service.ts`)
* Utilizes PDFKit to render vector-sharp, publication-ready commercial quotations on disk at `/uploads/quotations/`.
* Implements a remote image buffer fetcher that dynamically pulls the factory's cloud logo and renders it directly in the document header.
* Exports `generateQuotationEmailHtml` for responsive email notifications.

### F. Factory Quota Management (`src/routes/chat.routes.ts`)
* Endpoint `GET /api/chat/mockup/quota` counts monthly mockup usage against `factories.monthly_mockup_limit`.
* Allows automation gateways (n8n) to verify available quotas before initiating external API rendering calls.

### G. Factory Dashboard Authentication & Approval Gateway (`src/controllers/quote-dashboard.controller.ts`, `src/routes/quote-dashboard.routes.ts`)
* Introduces a second, independent approval path alongside the existing email webhook approval flow — both write to the same `quotations.status` column, so either can be used interchangeably without conflict.
* Secured by the pre-existing `authMiddleware` + `factoryMiddleware` pair (the same JWT-based login already used by `/api/products`), rather than the `x-factory-id` header — appropriate for a browser-based dashboard where the header alone would not be a secure boundary.
* `listQuotations`: Returns all quotations scoped to the logged-in factory's `req.user.factoryId`.
* `approveQuotation` / `rejectQuotation`: Call the existing `updateQuotationStatus` service function (Section 3B) to transition a quotation's status.

---

## 4. API Reference Summary

### `/api/chat` — Automation Gateway (n8n / bots)
All routes below are mounted under `/api/chat` and require the `x-factory-id` header.

* GET /api/chat/info: Returns factory metadata, specialty, logo URL, and `telegramBotUrl`.
* GET /api/chat/products: Lists active products, MOQs, prices, specifications, and template photos.
* GET /api/chat/products/:id: Returns single product (supports UUID or product name).
* GET /api/chat/mockup/quota: Returns factory monthly quota status (`allowed`, `used`, `limit`, `remaining`).
* POST /api/chat/leads: Registers or updates a client profile with conversational notes (name, email, company, country, notes).
* POST /api/chat/quote: Calculates landed manufacturing cost and creates quotation row (productId, quantity, tradeTerm, plateCost, colorCount).
* POST /api/chat/quote/:id/pdf: Programmatically draws branded PDF; returns download path.
* PATCH /api/chat/quote/:id/status: Allows admin dashboard to update status ('approved' / 'rejected').
* POST /api/chat/mockup/save: Records AI-rendered mockup URLs to PostgreSQL (product_id, logo_url, generated_image_url).

### `/api/quotations` — Factory Dashboard Gateway (browser login)
All routes below are mounted under `/api/quotations` and require a valid `Authorization: Bearer <JWT>` header from a logged-in factory user.

* GET /api/quotations: Lists every quotation belonging to the logged-in factory, newest first.
* POST /api/quotations/:id/approve: Sets the quotation's status to `'approved'`.
* POST /api/quotations/:id/reject: Sets the quotation's status to `'rejected'`.

---

## 5. Operations: Adding Real Factories & Complete Setup Guide

Follow this step-by-step procedure to onboard a live manufacturing facility from start to finish:

### Step 1: Create the Factory Record
Run this query in PostgreSQL to register the facility:
```sql
INSERT INTO factories (name, type, country, email, phone, logo_url, monthly_mockup_limit)
VALUES (
  'Precision Cups International',
  'Paper Packaging & Drinkware',
  'United States',
  'orders@precisioncups.com',
  '+1-800-555-0199',
  'https://yourcdn.com/logos/precision-logo.png',
  100
) RETURNING id;
Copy the generated UUID id. This is your FACTORY_ID).
Step 2: Create the Factory Manager Login (For Web Dashboard Access)
To allow the factory manager to log into the web dashboard to approve quotes and manage products, create their user account linked to that FACTORY_ID:
-- Run this query in PostgreSQL to register the facility:
-- ```sql
INSERT INTO users (email, password_hash, role, factory_id)
VALUES (
  'manager@precisioncups.com',
  '$2a$10$YourBcryptPasswordHashHere', -- Generated via bcrypt (cost factor 10)
  'factory',
  'YOUR_FACTORY_ID'
);
Step 3: Insert Factory Inventory & Specifications
Add the factory's products. You can include specifications (weight, dimensions, capacity, materials) directly into specification or description:
-- Run this query in PostgreSQL to register the facility:
-- ```sql
INSERT INTO products (
  factory_id, name, category, wall_type, moq, price, lead_time, description, specification, image_url
) VALUES (
  'YOUR_FACTORY_ID',
  '12oz Double Wall Insulated Coffee Cup',
  'Paper Cups',
  'double',
  1000,
  0.1200,
  '10-12 business days',
  'Matte finish thermal insulated cup.',
  'Weight: 14g, Capacity: 360ml, Material: Food-Grade Virgin Paperboard',
  '/uploads/products/Double-wall-cup.jpg'
);
Step 4: Configure Commercial Rules (Volume Discounts & Freight)
-- Run this query in PostgreSQL to register the facility:
-- ```sql
-- Volume discount tiers
INSERT INTO discount_tiers (factory_id, min_quantity, discount_percent)
VALUES 
  ('YOUR_FACTORY_ID', 2500, 5.00),
  ('YOUR_FACTORY_ID', 5000, 10.00);

-- Shipping freight rules
INSERT INTO shipping_rates (factory_id, destination_country, rate_type, rate_value)
VALUES 
  ('YOUR_FACTORY_ID', 'United States', 'flat', 75.00),
  ('YOUR_FACTORY_ID', NULL, 'flat', 120.00); -- Global fallback

  Step 5: Instant Live Deployment (Telegram & Website)
The factory's automated sales channels are immediately operational:
Dedicated Telegram Link:
https://t.me/YOUR_BOT_USERNAME?start=YOUR_FACTORY_ID
Website Chat Widget:
Embed the widget on the factory's webpage by passing its ID:
<ChatWidget factoryId="YOUR_FACTORY_ID" />
Step 6: Purging Demonstration Data (Going Live)
When ready to eliminate all test demonstration factories and records, run:
-- Run this query in PostgreSQL to register the facility:
-- ```sql
DELETE FROM factories WHERE email LIKE '%@testfactory.com';
(All associated products, quotes, mockups, and tiers will cascade-delete automatically).
---

## 6. Storefront Commerce: Quotation → Order Flow

Added on top of everything above. No pre-existing endpoint, service or table was
removed, and the `/api/chat` automation gateway is untouched — the only altered
constraint is `quotations_status_check`, which was *widened* (see below).

Migration: `npm run db:migrate` (`src/db/migrate-commerce.ts`, idempotent). The same
DDL runs inside `npm run db:init` so fresh installs match.

### A. Schema additions

| Table | Change |
|---|---|
| `leads` | `password_hash`, `status` (`prospect`/`active`/`inactive`), unique index on `(factory_id, LOWER(email))`. Leads now double as the **customer** record: the row the chatbot upserts is the row a storefront buyer signs in to. |
| `quotations` | `quote_number`, `valid_until`, `notes`, `customer_notes`, `destination_country`, `setup_fees`, `source` (`chatbot`/`storefront`). Status CHECK widened from `draft/sent/approved/rejected` to also allow `pending` and `expired`; every previous value stays legal. |
| `quotation_items` | **New.** One row per product on a quotation. `quotations.product_id/quantity/unit_price` are still populated from the first line so the chat flow and PDF generator keep working. |
| `orders` | **New.** `quotation_id` is UNIQUE — that is what makes approval idempotent. Status CHECK mirrors the frontend `OrderStatus` union exactly, so no mapping layer exists. |
| `order_status_history` | **New.** Append-only audit of every status change, with the note and the user who made it. |
| `factories` | `plate_cost_default`, `color_fee_default`, `default_currency`, `quote_validity_days` — the tooling fees that were previously magic numbers are now editable settings. |
| sequences | `quote_number_seq`, `order_number_seq` → `QT-2026-000123` / `ORD-2026-000123` (`src/services/numbering.service.ts`). |

### B. New services (`src/services/`)

* `quote-request.service.ts` — prices a cart and persists it. Volume discount, freight
  and setup fees all come from `calculateQuote()` (the existing engine, reading real
  `discount_tiers` / `shipping_rates`); because a cart has several unit prices, the
  engine is handed a blended price purely to *derive the rules*, then the money is
  rebuilt from exact per-line sums so a 4-dp blended price can't drift at 50,000 units.
  Validates MOQ and factory ownership on every line.
* `order.service.ts` — `createOrderFromQuotation` (idempotent, accepts a caller's
  transaction client), status transitions with history, fulfilment fields.
* `customer-auth.service.ts` — buyer register/login. Issues a JWT with
  `role: "customer"` and `leadId`; refuses to overwrite an account that already has a
  password.
* `quotation-view.service.ts`, `customer.service.ts`, `dashboard.service.ts`,
  `settings.service.ts`, `inbox.service.ts` — factory-scoped read models returning the
  camelCase shapes the UI renders. Chat-created single-product quotations are presented
  as a one-line quotation so every consumer can just read `items`.
* `numbering.service.ts` also exports `toDateOnly()`: node-postgres returns a `DATE` as
  a Date at *local* midnight, so `.toISOString()` reports the previous day east of UTC.
  Every DATE column is serialised through it as `YYYY-MM-DD`.

### C. Authentication boundary

`customerMiddleware` (`src/middleware/customer.middleware.ts`) requires
`role === "customer"`; the pre-existing `factoryMiddleware` requires `role === "factory"`.
Same `JWT_SECRET`, mutually exclusive roles — a buyer's token gets 403 from
`/api/products`, and a factory token gets 403 from `/api/public/me/*`. Every `/me/*`
handler filters by `leadId` **and** `factoryId`.

### D. API reference — storefront (`/api/public`)

| Method | Path | Auth |
|---|---|---|
| GET | `/factories/:username` | none |
| GET | `/factories/:username/products` | none |
| GET | `/factories/:username/products/:id` | none |
| POST | `/factories/:username/quote-preview` | none — live cart pricing, persists nothing |
| POST | `/factories/:username/customers/register` | none |
| POST | `/factories/:username/customers/login` | none |
| GET | `/me` | customer |
| POST | `/me/quote-requests` | customer — creates a `pending` quotation + items |
| GET | `/me/quotations`, `/me/quotations/:id` | customer |
| POST | `/me/quotations/:id/pdf` | customer |
| GET | `/me/orders`, `/me/orders/:id` | customer |

### E. API reference — dashboard (factory JWT)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/quotations`, `/api/quotations/:id` | enriched: customer, `items[]`, quote number, linked order |
| POST | `/api/quotations/:id/approve` | **sets `approved` and opens the order, in one transaction.** Returns `{ quotation, order }` |
| POST | `/api/quotations/:id/reject`, `/send`, `/pdf` | |
| PATCH | `/api/quotations/:id` | internal notes, validity date |
| GET | `/api/customers`, `/api/customers/:id` | detail returns profile + quotations + orders + merged activity timeline |
| PATCH | `/api/customers/:id` | notes, status, contact fields |
| GET | `/api/orders`, `/api/orders/:id` | detail returns `{ order, history }` |
| PATCH | `/api/orders/:id/status` | validates against the CHECK list, appends history |
| PATCH | `/api/orders/:id` | estimated delivery, tracking, notes |
| GET | `/api/dashboard/stats`, `/api/dashboard/analytics?days=N` | SQL aggregates; `generate_series` fills zero-activity days |
| GET | `/api/settings` · PATCH `/api/settings/factory` | profile + tooling fees + validity |
| POST/DELETE | `/api/settings/discount-tiers[/:id]` | the rules `pricing.service.ts` reads |
| POST/DELETE | `/api/settings/shipping-rates[/:id]` | |
| GET | `/api/inbox/conversations`, `/conversations/:id/messages`, `/mockups` | read-only views of the chat gateway's tables |

### F. Onboarding a factory for the storefront

Steps 1–4 of Section 5 still apply, with two additions:

1. The factory **must** have `factories.username` set — that is the subdomain the
   storefront is served on (`acme.yourdomain.com`). Without it the storefront 404s and
   the dashboard shows a notice saying so.
2. Discount tiers, freight rates and tooling fees no longer need raw SQL. The factory
   enters them at **Settings → Pricing & Discounts / Shipping**, and quotations pick
   them up immediately. With none configured, quoting is correct and simply applies no
   discount and no freight.

### G. Referential-integrity note

`quotations.lead_id` cascades on customer delete (pre-existing behaviour), while
`orders.lead_id` / `orders.quotation_id` are `ON DELETE SET NULL` — an order is a
financial record and must not vanish because a contact was removed. Deleting a customer
therefore leaves their orders in place with a null customer; the dashboard renders those
as "Unknown customer".
