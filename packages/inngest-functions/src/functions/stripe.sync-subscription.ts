import { inngest } from "../inngest.js";
import { syncSubscriptionFromStripe } from "@oxagen/billing";

// Event-driven mirror: API webhook emits the event after persisting the
// raw payload, runner re-syncs the canonical record. Decoupling keeps the
// webhook acknowledgement fast and lets Inngest handle retries on Stripe
// API hiccups.
export const stripeSyncSubscription = inngest.createFunction(
  { id: "stripe.sync-subscription", retries: 5 },
  { event: "stripe/subscription.updated" },
  async ({ event, step }) => {
    await step.run("sync", async () => {
      await syncSubscriptionFromStripe(event.data.stripeSubscriptionId);
    });
    return { synced: event.data.stripeSubscriptionId };
  },
);
