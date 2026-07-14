import { createFunction } from "../create-function";
import { logger } from "../logger";
import { provisionWebhookSubscription } from "../lib/provision-webhook";

/**
 * Provision a connection's webhook subscription when it goes active.
 *
 * Fired (event: ingestion/webhook.provision) after a webhook-declared connector
 * (microsoft / google-drive / google-gmail / google-calendar) is connected and
 * its OAuth credential is stored. Registers the provider subscription and writes
 * the ingestion.webhook_subscriptions row (encrypted secret + provider id +
 * expiry) so the delivery route (apps/api webhook.ts) can verify inbound
 * deliveries. Idempotent — safe to re-fire; provisionWebhookSubscription upserts
 * on the unique webhook_path.
 *
 * concurrency key on connectionId prevents a double-provision race if the event
 * is emitted twice for the same connection.
 */
export const [ingestionWebhookProvision] = createFunction(
  {
    id: "ingestion-webhook-provision",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.connectionId" },
  },
  { event: "ingestion/webhook.provision" },
  async ({ event, step }) => {
    const { connectionId, orgId } = event.data as {
      connectionId: string;
      orgId: string;
    };

    const result = await step.run("provision-subscription", () =>
      provisionWebhookSubscription(connectionId, orgId),
    );

    logger.info(
      { connectionId, orgId, outcome: result.outcome, reason: result.reason },
      "ingestion-webhook-provision: done",
    );

    return result;
  },
);
