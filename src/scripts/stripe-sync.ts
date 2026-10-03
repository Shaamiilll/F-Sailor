/**
 * Pushes the `plans` catalog into whichever Stripe account STRIPE_SECRET_KEY
 * points at: creates a product per plan, a price per interval, and writes the
 * resulting ids back onto each row.
 *
 *   npm run stripe:sync
 *
 * Safe to re-run -- it reuses what already matches and only creates a new price
 * when an amount has changed. You normally don't need to run this by hand: the
 * admin panel syncs a plan whenever it's created or edited. It's here for first
 * setup, and for pointing an existing catalog at a new Stripe account.
 */
import { pool } from "../config/db";
import { billingEnabled } from "../config/stripe";
import * as planService from "../services/plan.service";

async function main() {
  if (!billingEnabled) {
    console.error(
      "STRIPE_SECRET_KEY is not set. Add it to backend/.env before running this script."
    );
    process.exit(1);
  }

  const plans = await planService.listPlans();
  if (plans.length === 0) {
    console.error(
      'No plans found. Run "npm run db:migrate:billing" to seed the catalog first.'
    );
    process.exit(1);
  }

  console.log(`Syncing ${plans.length} plan(s) to Stripe...\n`);

  for (const plan of plans) {
    try {
      const synced = await planService.syncPlanToStripe(plan);
      console.log(`✓ ${synced.code}`);
      console.log(`    product: ${synced.stripeProductId}`);
      console.log(
        `    monthly: ${synced.stripeMonthlyPriceId ?? "— (no monthly price)"} ($${synced.monthlyPrice})`
      );
      console.log(
        `    annual:  ${synced.stripeAnnualPriceId ?? "— (no annual price)"} ($${synced.annualPrice})`
      );
    } catch (err) {
      console.error(`✗ ${plan.code}: ${(err as Error).message}`);
    }
  }

  console.log(
    "\nDone. Point Stripe at the webhook next. For local development:\n" +
      "  stripe listen --forward-to localhost:4000/api/billing/webhook\n" +
      "then copy the printed whsec_... into STRIPE_WEBHOOK_SECRET."
  );
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("Stripe sync failed:", err);
    process.exit(1);
  });
