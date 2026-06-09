import { inngest } from "../inngest";
import { syncInvoiceFromStripe } from "@oxagen/billing";
import { logger } from "../logger";

export const stripeSyncInvoice = inngest.createFunction(
  { id: "stripe.sync-invoice", retries: 5 },
  { event: "stripe/invoice.updated" },
  async ({ event, step }) => {
    const { stripeInvoiceId } = event.data as { stripeInvoiceId: string };
    await step.run("sync", async () => {
      await syncInvoiceFromStripe(stripeInvoiceId);
    });
    logger.info({ stripeInvoiceId }, "stripe.sync-invoice complete");
    return { synced: stripeInvoiceId };
  },
);
