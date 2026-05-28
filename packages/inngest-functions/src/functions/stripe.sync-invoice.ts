import { inngest } from "../inngest.js";
import { syncInvoiceFromStripe } from "@oxagen/billing";

export const stripeSyncInvoice = inngest.createFunction(
  { id: "stripe.sync-invoice", retries: 5 },
  { event: "stripe/invoice.updated" },
  async ({ event, step }) => {
    await step.run("sync", async () => {
      await syncInvoiceFromStripe(event.data.stripeInvoiceId);
    });
    return { synced: event.data.stripeInvoiceId };
  },
);
