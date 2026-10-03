/**
 * Pushes the `plans` catalog into whichever Paddle account PADDLE_API_KEY
 * points at: creates a product per plan, a price per interval, and writes the
 * resulting ids back onto each row.
 *
 *   npm run paddle:sync
 *
 * Safe to re-run -- it updates what already exists rather than duplicating it.
 * You normally don't need to run this by hand: the admin panel syncs a plan
 * whenever it's created or edited. It's here for first setup, and for pointing
 * an existing catalog at a different Paddle account or environment.
 */
import { pool } from "../config/db";
import { billingEnabled } from "../config/paddle";
import { env } from "../config/env";
import * as planService from "../services/plan.service";

async function main() {
  if (!billingEnabled) {
    console.error(
      "PADDLE_API_KEY is not set. Add it to backend/.env before running this script."
    );
    process.exit(1);
  }

  const plans = await planService.listPlans();
  if (plans.length === 0) {
    console.error(
      'No plans found. Run "npm run db:migrate:paddle" to seed the catalog first.'
    );
    process.exit(1);
  }

  console.log(
    `Syncing ${plans.length} plan(s) to Paddle (${env.paddle.environment}, ${env.paddle.currency})...\n`
  );

  let failures = 0;

  for (const plan of plans) {
    try {
      const synced = await planService.syncPlanToPaddle(plan);
      console.log(`✓ ${synced.code}`);
      console.log(`    product: ${synced.paddleProductId}`);
      console.log(
        `    monthly: ${synced.paddleMonthlyPriceId ?? "— (no monthly price)"} (${synced.monthlyPrice})`
      );
      console.log(
        `    annual:  ${synced.paddleAnnualPriceId ?? "— (no annual price)"} (${synced.annualPrice})`
      );
    } catch (err) {
      failures += 1;
      console.error(`✗ ${plan.code}: ${(err as Error).message}`);
    }
  }

  console.log(
    "\nDone. Next, point Paddle at the webhook:\n" +
      "  Paddle Dashboard > Developer tools > Notifications > New destination\n" +
      "  URL:    {your public api}/api/billing/webhook\n" +
      "  Events: transaction.completed, transaction.paid, transaction.payment_failed,\n" +
      "          subscription.created, subscription.updated, subscription.activated,\n" +
      "          subscription.canceled, subscription.paused, subscription.resumed\n" +
      "Then copy the destination's secret key into PADDLE_WEBHOOK_SECRET.\n" +
      "\nLocally, expose the API first (e.g. `ngrok http 4000`) -- Paddle has no\n" +
      "equivalent of `stripe listen` and must reach a public URL."
  );

  if (failures > 0) process.exitCode = 1;
}

main()
  .then(() => pool.end())
  .catch((err) => {
    console.error("Paddle sync failed:", err);
    process.exit(1);
  });
