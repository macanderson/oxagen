import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { logger } from "../logger";
import { provisionWebhookSubscription } from "../lib/provision-webhook";

interface ExpiringSubscription extends Record<string, unknown> {
  id: string;
  connection_id: string;
  org_id: string;
}

/**
 * Webhook subscription renewal cron.
 *
 * Provider push subscriptions expire (Microsoft Graph ~3 days, Google watch
 * channels ~7 days). Runs hourly, finds active subscriptions whose expires_at is
 * within a 24-hour window, and re-subscribes each by calling the same
 * provisionWebhookSubscription core the first-time provisioner uses — the
 * connector re-registers with the provider and the row's provider_subscription_id
 * / secret_enc / expires_at are updated in place (ON CONFLICT (webhook_path)).
 *
 * Error handling mirrors ingestion-oauth-refresh: a single connection's renewal
 * failing (a provider 4xx/5xx surfaced as a thrown error) is caught per-row,
 * logged, and marks the row status='error' so the delivery route stops trusting
 * a lapsed subscription — it does NOT abort the whole cron.
 */
export const [ingestionWebhookRenew] = createFunction(
  {
    id: "ingestion-webhook-renew",
    retries: 2,
  },
  { cron: "0 * * * *" },
  async ({ step }) => {
    // Join to source_connections for the org scope + a live, non-deleted parent.
    const expiring = await step.run("find-expiring-subscriptions", () =>
      withSystemDb(async (tx) => {
        const rows = await tx.execute(sql`
          SELECT ws.id,
                 ws.connection_id,
                 sc.org_id
          FROM   ingestion.webhook_subscriptions ws
          JOIN   ingestion.source_connections sc
                 ON sc.id = ws.connection_id
          WHERE  ws.status     = 'active'
          AND    ws.expires_at IS NOT NULL
          AND    ws.expires_at < NOW() + INTERVAL '24 hours'
          AND    sc.deleted_at IS NULL
          AND    sc.status NOT IN ('deleted', 'deleting', 'paused')
          ORDER  BY ws.expires_at ASC
          LIMIT  200
        `);
        return Array.from(rows) as ExpiringSubscription[];
      }),
    );

    logger.info(
      { count: expiring.length },
      "ingestion-webhook-renew: found expiring subscriptions",
    );

    let renewed = 0;
    for (const sub of expiring) {
      // NOTE: return the outcome from the step so the count survives Inngest's
      // replay model. A closure mutation (`renewed += 1`) inside the callback is
      // lost on replay because the step result is memoized and the callback is
      // not re-executed, so the count is derived from the memoized return value.
      const didRenew = await step.run(`renew-${sub.id}`, async () => {
        try {
          const result = await provisionWebhookSubscription(
            sub.connection_id,
            sub.org_id,
          );
          if (result.outcome === "subscribed") {
            logger.info(
              { subscriptionId: sub.id, connectionId: sub.connection_id },
              "ingestion-webhook-renew: subscription renewed",
            );
            return true;
          } else {
            // The connection can no longer provision (reconnect needed / config
            // gone). Mark the row error so the delivery route stops trusting a
            // subscription that will lapse without renewal.
            logger.warn(
              {
                subscriptionId: sub.id,
                connectionId: sub.connection_id,
                reason: result.reason,
              },
              "ingestion-webhook-renew: could not renew — marking subscription error",
            );
            await markSubscriptionError(sub.id);
            return false;
          }
        } catch (err) {
          logger.warn(
            {
              subscriptionId: sub.id,
              connectionId: sub.connection_id,
              err: err instanceof Error ? err.message : String(err),
            },
            "ingestion-webhook-renew: renewal threw — marking subscription error",
          );
          await markSubscriptionError(sub.id);
          return false;
        }
      });
      if (didRenew) renewed += 1;
    }

    return { checked: expiring.length, renewed };
  },
);

/** Flip a subscription to status='error' so lapsed rows stop being trusted. */
async function markSubscriptionError(subscriptionId: string): Promise<void> {
  await withSystemDb((tx) =>
    tx.execute(sql`
      UPDATE ingestion.webhook_subscriptions
      SET    status = 'error', updated_at = NOW()
      WHERE  id = ${subscriptionId}::uuid
    `),
  );
}
