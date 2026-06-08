import { Command } from "commander";
import { apiRequest, requireAuth , ApiError } from "../lib/api-client.js";

interface SubscriptionResponse {
  subscription?: {
    plan?: { name?: string };
    status?: string;
    currentPeriodEnd?: string;
  };
  creditBalance?: { balanceUsd?: number };
  credits?: { balance?: number };
}

export const billingStatusCommand = new Command("status")
  .description("Show current subscription and credit balance")
  .option("--org <slug>", "Organization slug")
  .action(async (options: { org?: string }) => {
    requireAuth();
    try {
      const qs = options.org ? `?org=${options.org}` : "";
      const data = await apiRequest<SubscriptionResponse>(`/billing/subscription${qs}`);
      const sub = data.subscription;
      if (sub) {
        console.log(`Plan: ${sub.plan?.name ?? "unknown"}`);
        console.log(`Status: ${sub.status ?? "unknown"}`);
        if (sub.currentPeriodEnd) console.log(`Renews: ${sub.currentPeriodEnd}`);
      } else {
        console.log("No active subscription.");
      }
      const balance = data.creditBalance?.balanceUsd ?? data.credits?.balance;
      if (balance !== undefined) console.log(`Credits: $${balance.toFixed(2)}`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
