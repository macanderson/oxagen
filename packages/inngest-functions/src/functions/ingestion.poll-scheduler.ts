import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { listConnectors } from "@oxagen/ingestion/connectors";
import { nextPollAt } from "@oxagen/ingestion/sync";
import { logger } from "../logger";

/**
 * Connector poll scheduler.
 *
 * Runs every 5 minutes. Finds live connections whose connector implements an
 * incremental poll() and are due (next_poll_at <= now, or never polled), then
 * fans out one `ingestion/connection.poll` event per connection so the
 * connection-poll function can fetch changed records into the ingestion
 * pipeline.
 *
 * Claiming: to keep the *next* scheduler tick from re-enqueuing a connection
 * that's still being polled, this optimistically pushes next_poll_at 5 minutes
 * forward at enqueue time (a short lease, one cron interval). The
 * connection-poll function then overwrites next_poll_at with the real
 * success/backoff schedule when it finishes. The lease only suppresses
 * re-enqueue for one tick; what actually guarantees a connection is never
 * polled twice concurrently is the per-connection concurrency key on
 * connection-poll.
 *
 * Only pollable connectors are enqueued — the set is computed from the
 * in-process connector registry, so adding a poll() to a connector
 * automatically opts it into the loop with no scheduler change.
 */
export const [ingestionPollScheduler] = createFunction(
  {
    id: "ingestion-poll-scheduler",
    retries: 2,
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // Connector ids that support incremental polling (have a poll() method).
    const pollableConnectorIds = listConnectors()
      .filter((c) => typeof c.poll === "function")
      .map((c) => c.connectorId);

    if (pollableConnectorIds.length === 0) {
      logger.info(
        {},
        "ingestion-poll-scheduler: no pollable connectors registered",
      );
      return { enqueued: 0, pollable: 0 };
    }

    // ── Step 1: Claim due connections (fetch + lease next_poll_at forward) ────
    // The claim UPDATE and the SELECT run in one statement via RETURNING so a
    // connection is atomically marked scheduled and returned for fan-out.
    const due = await step.run("claim-due-connections", () =>
      withSystemDb(async (tx) => {
        const rows = await tx.execute(sql`
          WITH due AS (
            SELECT id
            FROM   ingestion.source_connections
            WHERE  status = 'connected'
            AND    deleted_at IS NULL
            AND    connector_id = ANY(${sql.param(pollableConnectorIds)}::text[])
            AND    (next_poll_at IS NULL OR next_poll_at <= NOW())
            ORDER  BY next_poll_at ASC NULLS FIRST
            LIMIT  200
            FOR UPDATE SKIP LOCKED
          )
          UPDATE ingestion.source_connections sc
          SET    next_poll_at = NOW() + INTERVAL '5 minutes',
                 updated_at   = NOW()
          FROM   due
          WHERE  sc.id = due.id
          RETURNING sc.id, sc.org_id, sc.workspace_id, sc.connector_id
        `);
        return Array.from(rows) as Array<{
          id: string;
          org_id: string;
          workspace_id: string;
          connector_id: string;
        }>;
      }),
    );

    if (due.length === 0) {
      return { enqueued: 0, pollable: pollableConnectorIds.length };
    }

    // ── Step 2: Fan out one poll event per due connection ────────────────────
    await step.sendEvent(
      "dispatch-connection-polls",
      due.map((c) => ({
        name: "ingestion/connection.poll" as never,
        data: {
          connectionId: c.id,
          orgId: c.org_id,
          workspaceId: c.workspace_id,
          connectorId: c.connector_id,
        },
      })),
    );

    logger.info(
      { enqueued: due.length, pollable: pollableConnectorIds.length },
      "ingestion-poll-scheduler: dispatched connection polls",
    );

    return { enqueued: due.length, pollable: pollableConnectorIds.length };
  },
);

// Re-export only. This scheduler does NOT call nextPollAt — the claim above
// leases a flat 5 minutes; the real interval/backoff math runs in
// ingestion.connection-poll's finalize step. Any test that reads this export as
// proof the scheduler uses the helper is asserting something untrue.
export { nextPollAt };
