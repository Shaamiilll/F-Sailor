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

---


---

## 7. SaaS Billing: Self-Serve Signup, Plans & Paddle

The platform is self-serve. A visitor creates their own factory from the public
site, pays through Paddle, and their subdomain goes live — no admin involved.
An admin can still provision a factory directly, which takes no payment.

### A. Why Paddle, not Stripe

Paddle is a **Merchant of Record**: it sells to the customer, handles global
sales tax and VAT, and pays us out. Two things forced the move:

1. **Cross-border.** Our Stripe account could not charge overseas buyers at all
   (`This account isn't enabled to make cross border transactions`), which is
   fatal for a product sold to export factories worldwide. As MoR, Paddle is the
   seller of record, so this restriction does not apply.
2. **China.** Paddle can offer **Alipay** and **WeChat Pay** without a Chinese
   entity or merchant account. Stripe could not serve these buyers.

See the limits in section H before pricing for Chinese customers — they are
real and they constrain plan design.

### B. The plan catalog is data, not code

Plans live in the `plans` table and are managed from the admin panel
(**Admin → Plans & pricing**). Prices, channel limits, mockup allowances and
feature lists are all editable at runtime, and the public pricing page, the
signup form and every factory's limits read from the same rows.

`src/config/plans.ts` holds only the TypeScript shape plus `DEFAULT_PLANS`, the
three tiers seeded on first migration. Nothing reads those defaults at runtime —
reading them would make an admin's edits invisible.

| Column | Meaning |
| --- | --- |
| `code` | Stable identifier stored on `factories.plan`. Immutable once set. |
| `monthly_price` / `annual_price` | `0` for an interval means that interval is not sold. |
| `channel_limit` | How many sales channels may be active at once. |
| `monthly_mockup_limit` | AI logo mockups allowed per calendar month. |
| `features` | JSONB array of strings, rendered on the pricing page. |
| `active` | `false` hides it from pricing while existing subscribers keep working. |
| `paddle_product_id`, `paddle_*_price_id` | Written by the Paddle sync. |

Unlike Stripe, **Paddle prices are mutable**, so changing an amount updates the
price in place rather than creating a replacement. Paddle keeps billing current
subscribers at the amount they signed up for until their subscription is
explicitly changed, so editing the public price list still never re-bills an
existing customer.

### C. Factory lifecycle

`factories.status` gates access:

| Status | Dashboard access | Meaning |
| --- | --- | --- |
| `pending` | no (402) | Registered, subdomain reserved, has not paid. |
| `active` | yes | Paid, or admin-provisioned. |
| `past_due` | yes | Payment failed. Kept in with a banner — a lapsed card should not lock a factory out of its own data. |
| `canceled` | no (402) | Subscription ended. Data retained, access not. |
| `suspended` | no (402) | Switched off by an admin. |

`provisioned_by` is `self_serve` or `admin`. An `admin` factory has no Paddle
subscription by design and is never chased for payment.

`requireActiveSubscription` (`src/middleware/subscription.middleware.ts`) guards
every factory dashboard router. It answers **402**, not 403, so the frontend
keeps the session and routes to checkout instead of logging the user out.
`/api/billing/*` is deliberately *not* behind it — that is the one area a lapsed
account needs in order to start paying again.

### D. Signup flow

```
POST /api/public/register
  -> factory row created as `pending`, subdomain reserved, website channel seeded
  -> Paddle customer + transaction created (factory_id in customData)
  -> { factory, transactionId }

browser -> Paddle.js opens the checkout OVERLAY with that transactionId

Paddle -> POST /api/billing/webhook (transaction.completed)
  -> factory flips to `active`
```

**This differs from Stripe in shape, not just in vendor.** Stripe redirected to a
hosted checkout URL; Paddle renders checkout as an overlay in our own page. So
the backend returns a **transaction id, not a URL**, and the frontend opens the
overlay with it. Any code expecting `checkoutUrl` is pre-Paddle.

The **webhook**, not the browser, grants access: a user can close the overlay
before it reports success, and anything the browser sends can be forged — a
signed webhook cannot. The success page additionally re-reads the transaction
*from Paddle* as a fallback for when the webhook is slow, which is safe because
the transaction is re-fetched rather than trusted from the query string.

If Paddle refuses to open the transaction, the factory and user rows are rolled
back — otherwise an unpayable `pending` account would squat on the subdomain
forever.

### E. Setup

```bash
# 1. Apply the schema. On a database that ran the Stripe-era migration this
#    renames stripe_* columns to paddle_* and clears the old ids, so no data
#    is lost. Idempotent.
npm run db:migrate:paddle

# 2. backend/.env
#    PADDLE_API_KEY=pdl_sdbx_apikey_...
#    PADDLE_ENVIRONMENT=sandbox
#
#    Frontend/.env.local
#    NEXT_PUBLIC_PADDLE_CLIENT_TOKEN=test_...
#    NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox

# 3. Push the plan catalog into Paddle.
npm run paddle:sync

# 4. Paddle Dashboard > Developer tools > Notifications > New destination
#    URL: {public api}/api/billing/webhook
#    Copy its secret into PADDLE_WEBHOOK_SECRET.
```

**Sandbox and production are separate Paddle accounts** with separate keys,
client tokens and catalogs. Switching between them leaves every stored id
pointing at something that does not exist; the sync detects that and recreates
rather than failing, so a re-run is all that is needed.

There are **no price ids in `.env`** — each plan row carries its own, because an
admin can create a plan at runtime. Saving a plan in the admin panel syncs it
automatically; `npm run paddle:sync` is for first setup or a change of account.

> **Local webhooks:** Paddle has no equivalent of `stripe listen`. It must reach
> a public URL, so tunnel the API (`ngrok http 4000`) and point the notification
> destination at the tunnel. Without this the webhook never arrives and accounts
> stay `pending` — though the success page's fallback read will still activate
> them.

Without `PADDLE_API_KEY` the server still boots: self-serve signup and the
billing endpoints return a clear **503**, and an admin can provision factories
by hand.

### F. Limit enforcement

- **Mockups** — checked in `mockup.controller.createMockup` before generating
  (the expensive step), not only on the `/quota` endpoint, because the bot is
  free to skip that check. Over quota returns **403 `QUOTA_EXCEEDED`**.
- **Channels** — `setChannelEnabled` locks the factory row, counts active
  channels and refuses past the limit in one transaction, so two concurrent
  enables cannot both slip through. Returns **400 `PLAN_LIMIT`**.
- **Downgrades** never fail. Dropping to a smaller plan keeps the oldest N
  channels and switches the rest off.

`channel_limit` and `monthly_mockup_limit` are denormalized onto each factory so
these hot paths do not join. `plan.service.updatePlan` pushes new values out to
every factory on that plan, so the copies cannot drift.

### G. Webhook idempotency

Paddle delivers at least once and retries on failure. Every handled event id is
inserted into `subscription_events.provider_event_id` with
`ON CONFLICT DO NOTHING`; a duplicate delivery claims nothing and returns early.
Handler failures deliberately return 500 so Paddle retries — the ledger keeps
that retry from double-applying.

Signature verification uses the `Paddle-Signature` header and the **raw** body,
which is why the webhook is mounted with `express.raw()` *before* `express.json()`
in `index.ts`.

### H. Chinese payment methods — read before pricing

Paddle supports both, but with constraints that affect plan design:

| | Subscriptions | Constraints |
| --- | --- | --- |
| **Alipay** | ✅ Yes | Needs separate Paddle approval. Only shown to customers with a **China address paying in CNY**. **Renewals must not exceed ¥1,600** or the payment fails. |
| **WeChat Pay** | ❌ **One-time only** | Desktop only, China only, CNY/USD. Cannot back a recurring subscription. |

Consequences for the current catalog:

- **WeChat Pay cannot be used for any plan**, because every plan is a
  subscription. Offering it would need one-time purchases (e.g. a prepaid year
  sold as a single transaction) rather than a Paddle subscription.
- The **¥1,600 renewal cap is roughly $220**. Monthly plans are comfortably
  under it. **Annual plans are not**: Scale at $1,000/year is ≈¥7,100 and would
  fail on Alipay. If Alipay matters, either sell Chinese customers monthly only,
  or keep annual renewals under the cap.
- Alipay only appears when the customer's address is in China **and** the
  checkout is in CNY. `PADDLE_CURRENCY` sets the base currency plans are created
  in; Paddle converts for the buyer.

### I. API reference — billing

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/public/plans` | none | Live pricing catalog |
| `GET` | `/api/public/username-available?username=` | none | Subdomain availability |
| `POST` | `/api/public/register` | none | Self-serve signup, returns `transactionId` |
| `POST` | `/api/public/resume-checkout` | none | New transaction for a `pending` factory |
| `GET` | `/api/public/checkout-session?transaction_id=` | none | Confirm a completed checkout (also accepts `_ptxn`) |
| `POST` | `/api/billing/webhook` | Paddle signature | Subscription events (raw body) |
| `GET` | `/api/billing` | Factory | Plan, usage, channels, invoices |
| `POST` | `/api/billing/checkout` | Factory | Change plan, or open a transaction |
| `POST` | `/api/billing/portal` | Factory | Paddle customer portal URL |
| `POST` | `/api/billing/cancel` | Factory | Set/clear cancel-at-period-end |
| `GET` | `/api/billing/invoices/:id/pdf` | Factory | Short-lived invoice PDF link |
| `GET` / `PATCH` | `/api/billing/channels[/:channel]` | Factory | List / toggle channels |
| `GET` / `POST` | `/api/admin/plans` | Admin | List / create plans |
| `PATCH` / `DELETE` | `/api/admin/plans/:code` | Admin | Edit / delete a plan |
| `POST` | `/api/admin/plans/:code/sync` | Admin | Re-sync a plan to Paddle |
| `PATCH` | `/api/admin/factories/:id/plan` | Admin | Move a factory onto a plan |
| `PATCH` | `/api/admin/factories/:id/status` | Admin | Change a factory's status |

`POST /api/admin/factories` **requires** a `plan` and accepts an optional
`interval`. No payment is taken; the plan is what sets the account's limits.

> Deleting a plan is refused while any factory is on it (**409 `PLAN_IN_USE`**).
> Deactivate it instead: it disappears from pricing while subscribers keep working.
>
> Admin plan changes bypass Paddle — right for a comp or a correction, wrong for
> a real upgrade. Customers change their own plan from the billing page, which
> does go through Paddle and prorates.

---

## 8. WhatsApp Business Automation

A factory connects its own Meta WhatsApp number from **Dashboard → Configure**.
Buyers message that number and get an immediate reply composed from the
factory's own product catalog.

### A. What it reuses

Deliberately **not** a new message store. Inbound and outbound messages are
written to the existing `chat_sessions` / `chat_messages` tables with an
`external_user_id` of `whatsapp:<phone>`, which `inbox.service.detectChannel`
already classifies as WhatsApp. So WhatsApp threads appear in the Conversations
inbox next to web chat, and leads flow into `leads` as they always did.

`whatsapp_conversations` exists for a different reason: Meta bills and
rate-limits per **24-hour conversation window**, not per message, and the free
tier is **1,000 service conversations a month**. One row per window is what
makes that countable — that is the "1000 chats" the configure page reports.

### B. Tables

| Table | Purpose |
| --- | --- |
| `whatsapp_configs` | One row per factory: Meta credentials and all automation settings. |
| `whatsapp_conversations` | One row per 24-hour window. Drives the monthly quota meter and the handover flag. |
| `whatsapp_inbound_messages` | Just `wa_message_id`. Makes Meta's redeliveries no-ops. |

Credentials (`access_token_encrypted`, `app_secret_encrypted`) are **AES-256-GCM
encrypted at rest** via `crypto.service.ts`. GCM rather than CBC because it
authenticates the ciphertext, so a tampered row fails to decrypt instead of
yielding garbage we would then send to Meta. These values are never returned by
the API — the dashboard only ever sees `EAAG••••x9Qd`.

> Set `ENCRYPTION_KEY` (`openssl rand -hex 32`) in production. Without it the key
> is derived from `JWT_SECRET`, which means rotating `JWT_SECRET` would make
> every stored token undecryptable.

### C. The automation loop

```
Meta -> POST /api/whatsapp/webhook   (raw body, X-Hub-Signature-256 verified)
     -> 200 returned IMMEDIATELY, then processed async
     -> claim wa_message_id (dedupe)
     -> factory looked up by phone_number_id
     -> lead + chat message recorded
     -> conversation window found or opened
     -> reply composed from the catalog
     -> sent via Graph API, recorded as a bot message
```

The 200 is sent **before** processing because generating a reply involves a model
call plus an outbound send, both far slower than Meta's webhook timeout — and a
slow response makes Meta redeliver.

Each stage can bail quietly, by design. This runs after the response is already
committed, so an error must be logged, never thrown.

Checks applied in order: auto-reply off → stop. Thread already handed to a human
→ stop. Message contains a handover keyword → flag it, tell the buyer, stop.
Outside business hours and an away message is set → send that, stop. First
message of a new window and a greeting is set → send it. AI disabled → stop.

### D. Reply quality

`ai-reply.service.ts` builds the prompt from the factory's **active products**
(capped at 40) and the last 12 turns. The system prompt forbids inventing a
price, MOQ or lead time, forbids promising discounts, delivery dates or payment
terms, and tells the model to reply in the buyer's language.

That strictness is the point: a wrong MOQ quoted over WhatsApp is a commercial
problem, not just a bad answer. If generation fails, the configured fallback is
sent — or nothing at all, which is better than an error string, because the
factory's team still sees the message in the inbox.

Uses `@google/genai`, the model client this project already depended on.
`GEMINI_API_KEY` is optional: without it messages are still captured and shown
in Conversations, nothing is answered automatically, and the configure page says
so.

### E. Security boundaries

- **Webhook signature** — HMAC-SHA256 over the raw body against the factory's
  app secret. Checked before anything is parsed. Verification is opt-in: if no
  factory has an app secret stored, webhooks are accepted, because a factory can
  run the integration without sharing one and refusing everything would break the
  feature rather than secure it. The configure page recommends setting it.
- **Verify token** — generated per factory, compared in constant time. Meta's
  handshake carries no tenant identifier, so all tokens are checked.
- **Tenant isolation** — `phone_number_id` is UNIQUE, so an inbound message maps
  to exactly one factory. The invoice-PDF and handover endpoints re-check
  ownership rather than trusting an id from the client.
- **Subscription gate** — a `canceled` or `suspended` factory's messages are
  recorded but not answered, so a lapsed account cannot keep consuming WhatsApp
  quota or AI budget.

### F. Setup

```bash
npm run db:migrate:whatsapp

# backend/.env
PUBLIC_API_URL=https://your-api.example.com   # Meta must REACH this
ENCRYPTION_KEY=                                # openssl rand -hex 32
GEMINI_API_KEY=                                # optional; no key = no auto-replies
```

`PUBLIC_API_URL` is what the configure page shows the factory as their callback
URL. **In development it must be a tunnel** (`ngrok http 4000`) — Meta cannot
reach localhost, and the page warns when the URL still looks local.

The factory then does the rest themselves on **Dashboard → Configure**: paste the
callback URL and verify token into Meta, subscribe to the `messages` field, enter
their phone number ID and a permanent System User access token, press **Test
connection**, and configure the automation.

### G. API reference — WhatsApp

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/whatsapp/webhook` | verify token | Meta subscription handshake |
| `POST` | `/api/whatsapp/webhook` | Meta signature | Inbound messages (raw body) |
| `GET` | `/api/whatsapp/config` | Factory | Config, usage, channel and AI availability |
| `PATCH` | `/api/whatsapp/config` | Factory | Credentials and automation settings |
| `POST` | `/api/whatsapp/verify` | Factory | Check credentials against Meta |
| `POST` | `/api/whatsapp/disconnect` | Factory | Clear credentials |
| `POST` | `/api/whatsapp/test` | Factory | Send a test message |
| `PATCH` | `/api/whatsapp/conversations/:id/handover` | Factory | Hand a thread to/from a human |

> A blank `accessToken` or `appSecret` in a PATCH **keeps the stored value**. The
> client only ever holds a masked copy, so treating blank as "clear" would let a
> save of unrelated settings destroy a working credential.
