import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface BillingSubscriptionUpgradeStartResponse {
  checkoutUrl: string;
  planSlug: string;
  interval: "month" | "year";
}

export const billingSubscriptionUpgradeStartCommand = new Command("upgrade-start")
  .description("Start a Stripe Checkout session for a plan change")
  .requiredOption("-p, --plan <slug>", "Plan slug to upgrade to")
  .requiredOption("-i, --interval <interval>", "Billing interval: month or year")
  .requiredOption("--success-url <url>", "URL to redirect after successful upgrade")
  .requiredOption("--cancel-url <url>", "URL to redirect if upgrade is cancelled")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { plan: string; interval: string; successUrl: string; cancelUrl: string; org?: string }) => {
    try {
      const data = await apiRequest<BillingSubscriptionUpgradeStartResponse>("/billing/subscription/upgrade/start", {
        method: "POST",
        body: JSON.stringify({
          planSlug: options.plan,
          interval: options.interval,
          successUrl: options.successUrl,
          cancelUrl: options.cancelUrl,
          org_id: options.org,
        }),
      });
      console.log(`✓ Checkout session created for plan: ${data.planSlug} (${data.interval})`);
      console.log(`  Open this URL to complete the upgrade:`);
      console.log(`  ${data.checkoutUrl}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
