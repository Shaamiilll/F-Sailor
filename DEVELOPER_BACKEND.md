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