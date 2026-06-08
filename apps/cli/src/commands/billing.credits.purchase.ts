import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface CreditsPurchaseResponse {
  credits: number;
  totalCost: number;
  paymentUrl?: string;
}

export const billingCreditsPurchaseCommand = new Command("credits:purchase")
  .description("Purchase credits for the organization")
  .requiredOption("-a, --amount <number>", "Number of credits to purchase")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { amount: string; org?: string }) => {
    try {
      const amount = parseInt(options.amount, 10);
      if (isNaN(amount) || amount <= 0) {
        throw new Error("Amount must be a positive number");
      }
      console.log(`Purchasing ${amount} credits...`);
      const data = await apiRequest<CreditsPurchaseResponse>(
        "/billing/credits/purchase",
        {
          method: "POST",
          body: JSON.stringify({ amount, org_id: options.org }),
        }
      );
      console.log(`✓ Purchase initiated`);
      console.log(`  Credits: ${data.credits}`);
      console.log(`  Total cost: $${data.totalCost}`);
      if (data.paymentUrl) {
        console.log(`  Payment URL: ${data.paymentUrl}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
