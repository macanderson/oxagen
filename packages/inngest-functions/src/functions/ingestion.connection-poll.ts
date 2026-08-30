import { randomUUID } from "node:crypto";
import { createFunction } from "../create-function";
import { withSystemDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { getConnector } from "@oxagen/ingestion/connectors";
import type { RawRecord } from "@oxagen/ingestion/connectors";
import {
  advanceCursor,
  healthForFailureCount,
  nextPollAt,
  readCursor,
  mergeCursor,
} from "@oxagen/ingestion/sync";
import { insertEvents } from "@oxagen/telemetry";
import { logger } from "../logger";
import { resolveConnectionAuth } from "../lib/resolve-connection-auth";

// Cap the records pulled per record type per poll so a large backlog fans out
// across several polls (bounded via the advancing cursor) instead of one huge
// dispatch. The remaining backlog is picked up on the next scheduled poll.
const MAX_RECORDS_PER_TYPE = 200;
// Inngest batch size for entity.received fan-out.
const BATCH_SIZE = 50;

interface PollBatch {
  recordType: string;
  records: Array<{ sourceRecordType: string; payload: unknown }>;
  newCursor: string | null;
}

interface PollOutcome {
  ok: boolean;
  batches: PollBatch[];
  cursorMap: Record<string, unknown>;
  totalRecords: number;
  error?: string;
}

/**
 * Generic per-connection poll.
 *
 * Triggered by `ingestion/connection.poll` (fanned out by the poll scheduler).
 * For each of the connection's active record-type mappings it:
 *   1. resolves credentials (refreshing an expired OAuth token inline),
 *   2. calls the connector's poll() with the durable per-record-type cursor,
 *   3. dispatches one `ingestion/entity.received` per changed record into the
 *      existing 6-step ingestion pipeline,
 *   4. advances the cursor and rolls up connection health + the next poll time.
 *
 * Self-healing: a poll failure is caught (never thrown out of the function), the
 * consecutive-failure count is incremented, health transitions healthy →
 * degraded → errored, and next_poll_at is pushed out by exponential backoff so
 * the scheduler retries on a widening interval. A success resets the count and
 * schedules the connector's steady-state interval.
 *
 * SECURITY: the decrypted access token lives only inside the poll step's
 * closure — it is never a step return value (which Inngest would persist to its
 * state store) and never logged.
 */
export const [ingestionConnectionPoll] = createFunction(
  {
    id: "ingestion-connection-poll",
    // Own the backoff via next_poll_at; a low retry count only covers genuine
    // infra blips (DB) before we can record the failure ourselves.
    retries: 2,
    // One poll per connection at a time — the scheduler's next_poll_at lease
    // plus this key make concurrent double-polls impossible.
    concurrency: { limit: 1, key: "event.data.connectionId" },
  },
  { event: "ingestion/connection.poll" },
  async ({ event, step }) => {
    const { connectionId, orgId, workspaceId, connectorId } = event.data as {
      connectionId: string;
      orgId: string;
      workspaceId: string;
      connectorId: string;
    };

    // ── Step 1: Load mapped record types + current cursor ────────────────────
    const loaded = await step.run("load-connection", async () => {
      const rows = await withSystemDb(async (tx) => {
        const conn = await tx.execute(sql`
          SELECT cursor, consecutive_failure_count, status
          FROM   ingestion.source_connections
          WHERE  id = ${connectionId}::uuid AND org_id = ${orgId}::uuid
          AND    deleted_at IS NULL
          LIMIT  1
        `);
        const mappings = await tx.execute(sql`
          SELECT DISTINCT source_record_type
          FROM   ingestion.entity_type_mappings
          WHERE  connection_id = ${connectionId}::uuid
          AND    is_active = true
        `);
        return {
          conn: Array.from(conn) as Array<{
            cursor: Record<string, unknown> | null;
            consecutive_failure_count: number;
            status: string;
          }>,
          mappings: Array.from(mappings) as Array<{
            source_record_type: string;
          }>,
        };
      });
      const conn = rows.conn[0];
      return {
        found: !!conn && conn.status === "connected",
        cursorMap: conn?.cursor ?? {},
        consecutiveFailureCount: conn?.consecutive_failure_count ?? 0,
        recordTypes: rows.mappings.map((m) => m.source_record_type),
      };
    });

    if (!loaded.found) {
      logger.info(
        { connectionId, orgId },
        "ingestion-connection-poll: connection not found or not connected — skipping",
      );
      return { skipped: true, reason: "not_connected" };
    }

    // ── Step 2: Resolve auth + poll every mapped record type ─────────────────
    // Everything that touches the decrypted token happens INSIDE this step and
    // only public source records / cursor strings are returned.
    const outcome = await step.run(
      "poll-records",
      async (): Promise<PollOutcome> => {
        const connector = getConnector(connectorId);
        if (typeof connector.poll !== "function") {
          // Scheduler shouldn't enqueue these, but guard anyway.
          return {
            ok: true,
            batches: [],
            cursorMap: loaded.cursorMap,
            totalRecords: 0,
          };
        }

        const resolved = await resolveConnectionAuth(connectionId, orgId);
        if (!resolved) {
          return {
            ok: false,
            batches: [],
            cursorMap: loaded.cursorMap,
            totalRecords: 0,
            error: "no_usable_credential",
          };
        }

        // Validate the connection config against the connector's schema; a bad
        // stored config is a permanent poll failure, not a transient one.
        const parsedConfig = connector.connectionConfigSchema.safeParse(
          resolved.deliveryConfig,
        );
        if (!parsedConfig.success) {
          return {
            ok: false,
            batches: [],
            cursorMap: loaded.cursorMap,
            totalRecords: 0,
            error: `invalid_config: ${parsedConfig.error.issues.map((i) => i.path.join(".")).join(",")}`,
          };
        }

        let cursorMap = loaded.cursorMap;
        const batches: PollBatch[] = [];
        let totalRecords = 0;

        try {
          for (const recordType of loaded.recordTypes) {
            const priorCursor = readCursor(cursorMap, recordType);
            const collected: RawRecord[] = [];
            for await (const rec of connector.poll(
              resolved.auth,
              parsedConfig.data,
              recordType,
              priorCursor,
            )) {
              collected.push(rec);
              if (collected.length >= MAX_RECORDS_PER_TYPE) break;
            }
            if (collected.length === 0) continue;

            const newCursor = advanceCursor(
              connector,
              recordType,
              collected,
              priorCursor,
            );
            cursorMap = mergeCursor(cursorMap, recordType, newCursor);
            totalRecords += collected.length;
            batches.push({
              recordType,
              records: collected.map((r) => ({
                sourceRecordType: r.sourceRecordType,
                payload: r.raw,
              })),
              newCursor,
            });
          }
        } catch (err) {
          return {
            ok: false,
            batches,
            cursorMap,
            totalRecords,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        return { ok: true, batches, cursorMap, totalRecords };
      },
    );

    // ── Step 3: Dispatch entity.received into the ingestion pipeline ─────────
    // Top-level step.sendEvent so the fan-out is durably checkpointed. Records
    // already fetched are dispatched even if a later record type failed.
    for (let b = 0; b < outcome.batches.length; b++) {
      const batch = outcome.batches[b]!;
      for (let i = 0; i < batch.records.length; i += BATCH_SIZE) {
        const slice = batch.records.slice(i, i + BATCH_SIZE);
        await step.sendEvent(
          `emit-${b}-${i}`,
          slice.map((rec) => ({
            name: "ingestion/entity.received" as never,
            data: {
              connectionId,
              workspaceId,
              orgId,
              connectorType: connectorId,
              sourceRecordType: rec.sourceRecordType,
              payload: rec.payload,
            },
          })),
        );
      }
    }

    // ── Step 4: Persist cursor + health + next poll schedule ─────────────────
    await step.run("finalize", async () => {
      const now = new Date();
      if (outcome.ok) {
        const intervalSeconds =
          getConnector(connectorId).defaultPollIntervalSeconds ?? 900;
        const next = nextPollAt({
          now,
          intervalSeconds,
          consecutiveFailures: 0,
        });
        await withSystemDb((tx) =>
          tx.execute(sql`
            UPDATE ingestion.source_connections
            SET    cursor                    = ${JSON.stringify(outcome.cursorMap)}::jsonb,
                   health_status             = 'healthy',
                   consecutive_failure_count = 0,
                   error_message             = NULL,
                   last_poll_at              = ${now.toISOString()},
                   last_sync_at              = ${now.toISOString()},
                   next_poll_at              = ${next.toISOString()},
                   entity_count              = entity_count + ${outcome.totalRecords},
                   updated_at                = NOW()
            WHERE  id = ${connectionId}::uuid AND org_id = ${orgId}::uuid
          `),
        );
      } else {
        const failures = loaded.consecutiveFailureCount + 1;
        const health = healthForFailureCount(failures);
        const intervalSeconds =
          getConnector(connectorId).defaultPollIntervalSeconds ?? 900;
        const next = nextPollAt({
          now,
          intervalSeconds,
          consecutiveFailures: failures,
        });
        await withSystemDb((tx) =>
          tx.execute(sql`
            UPDATE ingestion.source_connections
            SET    cursor                    = ${JSON.stringify(outcome.cursorMap)}::jsonb,
                   health_status             = ${health},
                   consecutive_failure_count = ${failures},
                   error_message             = ${outcome.error ?? "poll_failed"},
                   last_poll_at              = ${now.toISOString()},
                   last_error_at             = ${now.toISOString()},
                   next_poll_at              = ${next.toISOString()},
                   entity_count              = entity_count + ${outcome.totalRecords},
                   updated_at                = NOW()
            WHERE  id = ${connectionId}::uuid AND org_id = ${orgId}::uuid
          `),
        );
      }
    });

    // ── Step 5: Ingestion telemetry → ClickHouse (fire-and-forget) ───────────
    await step.run("emit-telemetry", async () => {
      try {
        await insertEvents([
          {
            event_id: randomUUID(),
            org_id: orgId,
            workspace_id: workspaceId,
            event_type: outcome.ok
              ? "connector.poll.completed"
              : "connector.poll.failed",
            source_system: "connector-sync",
            stream_offset: null,
            payload: JSON.stringify({
              connectionId,
              connectorId,
              recordTypes: loaded.recordTypes,
              totalRecords: outcome.totalRecords,
              error: outcome.error ?? null,
            }),
            emitted_at: new Date().toISOString(),
          },
        ]);
      } catch (telErr) {
        logger.warn(
          { connectionId, err: telErr },
          "connector.poll telemetry write failed",
        );
      }
    });

    logger.info(
      {
        connectionId,
        orgId,
        connectorId,
        ok: outcome.ok,
        records: outcome.totalRecords,
      },
      "ingestion-connection-poll: completed",
    );

    return {
      connectionId,
      ok: outcome.ok,
      records: outcome.totalRecords,
      recordTypes: loaded.recordTypes.length,
    };
  },
);
