# Backend Architecture & API Integration Guide

**Author:** Aeraj Fatima — AI Automation Engineer  
**Scope:** PostgreSQL Schemas, Industrial Pricing Engine, Document Compilation, and Multi-Tenant REST API  
**Environment:** Node.js / TypeScript / Express / PostgreSQL  

---

## 1. Architectural Overview & Non-Breaking Guarantee

To support autonomous, multi-channel B2B quotation generation, an isolated, multi-tenant API layer was engineered to integrate directly with the existing Node.js & PostgreSQL backend.

### Non-Breaking Guarantee
* All pre-existing production endpoints—including `/api/auth`, `/api/admin`, and `/api/products`—remain 100% intact and untouched.
* All conversational, quoting, and memory features operate under the dedicated `/api/chat` namespace.
* Multi-tenancy is enforced at the gateway level using the `x-factory-id` header, ensuring zero data contamination between separate manufacturing facilities.

---

## 2. PostgreSQL Database Migrations & Schemas

The following non-destructive extensions and schemas were added to the primary PostgreSQL database:

### A. Non-Destructive Table Alterations
- Added `image_url` VARCHAR(500) to `products` for blank product template photos.
- Added `logo_url` VARCHAR(500) to `factories` for programmatic PDF rendering.
- Added `notes` TEXT to `leads` for persistent customer requirements and conversational memory.
- Added `plate_cost` DECIMAL(12, 4) to `quotations` for one-time printing tooling fees.
- Added `color_count` INTEGER to `quotations` for tracking multi-color print passes.
- Added `trade_term` VARCHAR(20) to `quotations` for Incoterms tracking (EXW vs. FOB).

### B. Core Tables Added for B2B Operations
1. `quotations`: Stores price snapshots, applied discount percentages, freight fees, setup fees, trade terms, and compiled PDF URLs.
2. `discount_tiers`: Factory-configurable volume discount rules (e.g., 5% off at 2,500 units, 10% off at 5,000 units).
3. `shipping_rates`: Configurable freight rules per factory and destination country.
4. `mockups`: Storage of AI-rendered product visuals associated with customer logo URLs.
5. `chat_sessions` & `chat_messages`: PostgreSQL-backed session persistence for multi-turn conversational memory.
6. `n8n_chat_histories`: LangChain-compatible conversation buffer.

---

## 3. Backend Micro-Services Inventory (src/)

### A. Industrial Pricing Engine (src/services/pricing.service.ts)
Calculates manufacturing landed costs deterministically via code rather than probabilistic AI estimates:
Grand Total = (Base Price + Add-ons) * Quantity * (1 - Discount) + Setup Fees + Freight

* Plate / Screen Setup Fees: One-time tooling fee per production run (default $50.00).
* Multi-Color Printing: Incremental fee for complex artwork (default $20.00 per additional color beyond 1).
* Component Add-ons: Per-unit accessories (e.g., biodegradable PLA lids at +$0.03/unit).
* Incoterms / Trade Terms: 
  - EXW (Ex-Works / Factory Gate): Customer arranges pickup ($0 freight).
  - FOB (Free On Board): Local drayage and seaport delivery handling ($75 flat).
  - DDP: International door-to-door delivery derived from shipping_rates.

### B. Quotation Lifecycle & Resilience Service (src/services/quote.service.ts)
* Foreign Key Defense: Validates whether an incoming leadId exists in the database. If an unverified or null identifier is provided, it safely falls back to NULL to prevent PostgreSQL foreign key constraint crashes (22P02).
* Lead Auto-Linking: If a quote request omits leadId, the service automatically searches for the most recent customer record created for that factory and links the quote seamlessly.
* Granular Persistence: Persists plate_cost, color_count, and trade_term into distinct database columns for clean admin dashboard inspection.

### C. Alphanumeric & Fuzzy Product Matcher (src/services/db.service.ts)
The findProductById function implements a two-tier lookup:
1. UUID Path: Validates RFC4122 regex; queries by primary key if valid.
2. Alphanumeric Normalization: If a slug or name is passed (e.g., "double-wall-insulated-coffee-cup-12oz"), it strips all non-alphanumeric characters and executes a fuzzy regex match against products.name. This eliminates URL decoding and hyphenation crashes.

### D. Lead Management & Deduplication (src/services/lead.service.ts)
* Implements an intelligent upsert pattern based on customer email.
* If a customer returns with new requirements, their profile is updated, and fresh order notes are appended to the notes column rather than duplicating customer rows.

### E. Programmatic PDF Document Generator (src/services/pdf.service.ts)
* Utilizes PDFKit to render vector-sharp, publication-ready commercial quotations on disk at /uploads/quotations/.
* Implements a remote image buffer fetcher that dynamically pulls the factory's cloud logo and renders it directly in the document header.
* Exports generateQuotationEmailHtml for responsive email notifications.

---

## 4. API Reference Summary

All routes are mounted under /api/chat and require the x-factory-id header.

* GET /api/chat/info: Returns factory metadata, specialty, and logo URL.
* GET /api/chat/products: Lists active products, MOQs, prices, and blank photos.
* GET /api/chat/products/:id: Returns single product (supports UUID or URL-encoded name).
* POST /api/chat/leads: Registers or updates a client profile with conversational notes (name, email, company, country, notes).
* POST /api/chat/quote: Calculates landed manufacturing cost and creates quotation row (productId, quantity, tradeTerm, plateCost, colorCount).
* POST /api/chat/quote/:id/pdf: Programmatically draws branded PDF; returns download path.
* PATCH /api/chat/quote/:id/status: Allows admin dashboard to update status ('approved' / 'rejected').
* POST /api/chat/mockup/save: Records AI-rendered mockup URLs to PostgreSQL (product_id, logo_url, generated_image_url).

---

## 5. Operations: Adding Real Factories & Launching Production

To deploy a live manufacturing facility without writing code:

### Step 1: Insert Factory
INSERT INTO factories (name, type, country, email, phone, logo_url)
VALUES (
  'Precision Cups International',
  'Paper Packaging & Drinkware',
  'United States',
  'orders@precisioncups.com',
  '+1-800-555-0199',
  'https://yourcdn.com/logos/precision-logo.png'
) RETURNING id;

### Step 2: Insert Verified Inventory
INSERT INTO products (
  factory_id, name, category, wall_type, moq, price, lead_time, description, image_url
) VALUES (
  'YOUR_FACTORY_ID',
  '12oz Double Wall Insulated Coffee Cup',
  'Paper Cups',
  'double',
  1000,
  0.1200,
  '10-12 business days',
  'Matte finish thermal insulated cup.',
  'https://yourcdn.com/products/blank-12oz-cup.png'
);

### Step 3: Configure Commercial Rules
-- Volume discounts
INSERT INTO discount_tiers (factory_id, min_quantity, discount_percent)
VALUES 
  ('YOUR_FACTORY_ID', 2500, 5.00),
  ('YOUR_FACTORY_ID', 5000, 10.00);

-- Shipping freight
INSERT INTO shipping_rates (factory_id, destination_country, rate_type, rate_value)
VALUES ('YOUR_FACTORY_ID', 'United States', 'flat', 75.00);

### Step 4: Purging Test Seed Data
When ready to eliminate demonstration data, run:
DELETE FROM factories WHERE email LIKE '%@testfactory.com';
(All dependent test records cascade automatically).