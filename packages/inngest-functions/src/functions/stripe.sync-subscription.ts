import { createFunction } from "../create-function";
import { syncSubscriptionFromStripe } from "@oxagen/billing";
import { logger } from "../logger";

// Event-driven mirror: API webhook emits the event after persisting the
// raw payload, runner re-syncs the canonical record. Decoupling keeps the
// webhook acknowledgement fast and lets Inngest handle retries on Stripe
// API hiccups.
export const [stripeSyncSubscription] = createFunction(
  { id: "stripe.sync-subscription", retries: 5 },
  { event: "stripe/subscription.updated" },
  async ({ event, step }) => {
    const { stripeSubscriptionId } = event.data as {
      stripeSubscriptionId: string;
    };
    await step.run("sync", async () => {
      await syncSubscriptionFromStripe(stripeSubscriptionId);
    });
    logger.info({ stripeSubscriptionId }, "stripe.sync-subscription complete");
    return { synced: stripeSubscriptionId };
  },
);
