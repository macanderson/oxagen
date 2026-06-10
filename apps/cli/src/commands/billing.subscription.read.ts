import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface Subscription {
  id: string;
  plan: string;
  status: string;
  nextBillingDate?: string;
}

interface SubscriptionReadResponse {
  subscription: Subscription;
}

export const billingSubscriptionReadCommand = new Command("subscription:read")
  .description("Read current subscription details")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { org?: string }) => {
    try {
      const params = new URLSearchParams();
      const orgId = options.org ?? getOrgId();
      if (orgId) params.append("org_id", orgId);
      const data = await apiRequest<SubscriptionReadResponse>(
        `/billing/subscription/read?${params}`,
        { method: "GET" }
      );
      const sub = data.subscription;
      console.log("Current Subscription:");
      console.log(`  Plan: ${sub.plan}`);
      console.log(`  Status: ${sub.status}`);
      if (sub.nextBillingDate) {
        console.log(`  Next billing: ${sub.nextBillingDate}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
