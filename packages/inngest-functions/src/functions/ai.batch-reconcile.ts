import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { withSystemDb, withTenantDb, schema } from "@oxagen/database";
import { pollBatch } from "@oxagen/ai";
import { insertEvents } from "@oxagen/telemetry";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "../logger";
import {
  connectionIdFromKey,
  parseFeaturesFromText,
  writeAcceptedFeatures,
} from "./ingestion.feature-inference";

// A batch that has not ended after this many hours is treated as dead: the
// Anthropic Message Batches API expires batches at 24h, so anything still open
// well past that will never complete. We mark it failed and emit an event.
const DEAD_BATCH_HOURS = 26;
// Cap rows processed per run so one tick can't run unboundedly.
const MAX_ROWS_PER_RUN = 50;

interface StuckRow {
  id: string;
  orgId: string;
  workspaceId: string;
  providerBatchId: string | null;
  model: string;
  submittedAt: Date | null;
}

/**
 * ai.batch-reconcile — sweeps orphaned Anthropic batch jobs.
 *
 * The batched feature-inference consumer polls a submitted batch inline, but
 * caps its poll window (~1h). A batch that ends after the cap — or a run that
 * crashed mid-poll — leaves its `ai.batch_jobs` row in `submitted`/`in_progress`
 * with the results never applied. This cron (every 15m) finds those rows, polls
 * each batch once, and on completion finalizes the tracking row + writes the
 * Feature nodes (metering happens inside pollBatch). Batches still open past the
 * provider's 24h expiry are marked `failed` with a telemetry event.
 *
 * Cross-tenant read via withSystemDb (audited RLS bypass — a trusted system
 * sweep); every write runs inside the row's own tenant scope.
 */
export const [ingestionBatchReconcile] = createFunction(
  { id: "ai-batch-reconcile", retries: 1 },
  { cron: "*/15 * * * *" },
  async ({ step }) => {
    const rows = (await step.run("find-open-batches", () =>
      withSystemDb((tx) =>
        tx
          .select({
            id: schema.aiBatchJobs.id,
            orgId: schema.aiBatchJobs.orgId,
            workspaceId: schema.aiBatchJobs.workspaceId,
            providerBatchId: schema.aiBatchJobs.providerBatchId,
            model: schema.aiBatchJobs.model,
            submittedAt: schema.aiBatchJobs.submittedAt,
          })
          .from(schema.aiBatchJobs)
          .where(
            and(
              inArray(schema.aiBatchJobs.status, ["submitted", "in_progress"]),
              isNull(schema.aiBatchJobs.deletedAt),
            ),
          )
          .limit(MAX_ROWS_PER_RUN),
      ),
    )) as StuckRow[];

    const open = rows.filter((r) => r.providerBatchId);
    if (open.length === 0) return { checked: 0, finalized: 0, failed: 0 };

    let finalized = 0;
    let failed = 0;

    for (const row of open) {
      const { orgId, workspaceId, model } = row;
      const batchId = row.providerBatchId!;

      const poll = await step.run(`poll-${row.id}`, () =>
        pollBatch({
          batchId,
          model,
          telemetry: { orgId, workspaceId, surface: "ingestion" },
        }),
      );

      if (!poll.ended) {
        const ageHours = row.submittedAt
          ? (Date.now() - row.submittedAt.getTime()) / 3_600_000
          : 0;
        if (ageHours >= DEAD_BATCH_HOURS) {
          await step.run(`fail-${row.id}`, () =>
            runInTenantScope({ orgId, workspaceId }, async () => {
              await updateRow(batchId, {
                status: "failed",
                completedAt: new Date(),
              });
              await emitReconcileEvent(orgId, workspaceId, batchId, "failed", {
                ageHours,
              });
            }),
          );
          failed += 1;
        }
        continue;
      }

      // Ended: finalize counts, write Features for succeeded files, emit event.
      await step.run(`finalize-${row.id}`, () =>
        runInTenantScope({ orgId, workspaceId }, async () => {
          await updateRow(batchId, {
            status: "ended",
            succeededCount: poll.counts.succeeded,
            erroredCount: poll.counts.errored,
            expiredCount: poll.counts.expired,
            canceledCount: poll.counts.canceled,
            completedAt: new Date(),
          });

          const session = scopedSession();
          try {
            for (const r of poll.results) {
              if (r.type !== "succeeded" || !r.text) continue;
              const features = parseFeaturesFromText(r.text);
              if (features.length === 0) continue;
              await writeAcceptedFeatures(
                session,
                {
                  orgId,
                  workspaceId,
                  connectionId: connectionIdFromKey(r.customId),
                  fileNaturalKey: r.customId,
                  authority: { method: "llm-feature-inference-batch", model },
                },
                features,
              );
            }
          } finally {
            await session.close();
          }

          await emitReconcileEvent(
            orgId,
            workspaceId,
            batchId,
            "ended",
            poll.counts,
          );
        }),
      );
      finalized += 1;
    }

    logger.info(
      { checked: open.length, finalized, failed },
      "ai-batch-reconcile: sweep complete",
    );
    return { checked: open.length, finalized, failed };
  },
);

/** Patch an ai.batch_jobs row by provider batch id (inside a tenant scope). */
async function updateRow(
  providerBatchId: string,
  patch: Partial<typeof schema.aiBatchJobs.$inferInsert>,
): Promise<void> {
  await withTenantDb((tx) =>
    tx
      .update(schema.aiBatchJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.aiBatchJobs.providerBatchId, providerBatchId)),
  );
}

/** Emit a reconcile outcome to ClickHouse (best-effort). */
async function emitReconcileEvent(
  orgId: string,
  workspaceId: string,
  batchId: string,
  outcome: "ended" | "failed",
  detail: Record<string, unknown>,
): Promise<void> {
  try {
    await insertEvents([
      {
        event_id: crypto.randomUUID(),
        org_id: orgId,
        workspace_id: workspaceId,
        event_type: `ai.batch.reconcile.${outcome}`,
        source_system: "ai",
        stream_offset: null,
        payload: JSON.stringify({ batch_id: batchId, ...detail }),
        emitted_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    logger.error({ err, batchId }, "ai-batch-reconcile event write failed");
  }
}
