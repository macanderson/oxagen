import { inngest } from "../inngest";
import { syncInvoiceFromStripe } from "@oxagen/billing";
import { logger } from "../logger";

export const stripeSyncInvoice = inngest.createFunction(
  { id: "stripe.sync-invoice", retries: 5 },
  { event: "stripe/invoice.updated" },
  async ({ event, step }) => {
    await step.run("sync", async () => {
      await syncInvoiceFromStripe(event.data.stripeInvoiceId);
    });
    logger.info({ stripeInvoiceId: event.data.stripeInvoiceId }, "stripe.sync-invoice complete");
    return { synced: event.data.stripeInvoiceId };
  },
);
