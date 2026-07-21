import { createFunction } from "../create-function";
import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "@oxagen/ontology/tenant";
import { withTenantDb, schema } from "@oxagen/database";
import { submitBatch, pollBatch } from "@oxagen/ai";
import { logger } from "../logger";
import {
  FEATURE_SYSTEM_PROMPT,
  buildFeaturePrompt,
  parseFeaturesFromText,
  writeAcceptedFeatures,
  type FeatureSymbol,
} from "./ingestion.feature-inference";

// Bare Anthropic model id — batches bypass the AI Gateway, so this is NOT a
// gateway `creator/model` slug. Haiku is the right tier for bulk feature
// extraction where latency doesn't matter and half-price matters.
const BATCH_MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 1024;
// Poll cadence + cap. Most batches end well under an hour; a batch still
// running past the cap leaves its tracking row `in_progress` for a reconcile
// sweep rather than blocking the run indefinitely.
const POLL_INTERVAL = "60s";
const MAX_POLLS = 60;

interface FeatureEventData {
  fileNaturalKey: string;
  symbols: FeatureSymbol[];
  orgId: string;
  workspaceId: string;
  connectionId: string;
}

/**
 * Batched GitHub feature-inference.
 *
 * Consumes `ingestion/github.infer-features-batch` events with Inngest
 * `batchEvents`: up to 50 per-file events (or 30s) are collected into one run
 * and submitted as a SINGLE Anthropic Message Batch (half price, async). This
 * is the same inference the per-file `ingestion.github-infer-features` function
 * does synchronously — the schema, prompt, and Neo4j write are shared via
 * ./ingestion.feature-inference so the two paths never drift.
 *
 * Opt-in: `ingestion.github-parse-file` emits this event instead of the
 * per-file one only when `INGESTION_FEATURE_BATCH=1`. Each batch submission is
 * tracked in `ai.batch_jobs`; metering (token_usage + credits) is emitted by
 * pollBatch on completion.
 */
export const [ingestionGithubInferFeaturesBatch] = createFunction(
  {
    id: "ingestion-github-infer-features-batch",
    retries: 2,
    // Collect per-file events into one run, partitioned per org so a batch
    // never mixes tenants.
    batchEvents: { maxSize: 50, timeout: "30s", key: "event.data.orgId" },
  },
  { event: "ingestion/github.infer-features-batch" },
  async ({ events, step }) => {
    const all = (events ?? []).map(
      (e) => e.data as unknown as FeatureEventData,
    );
    if (all.length === 0) return { batches: 0, filesWritten: 0 };

    // batchEvents partitions by org, but not workspace — group so metering and
    // graph writes stay correctly scoped when one org spans workspaces.
    const byWorkspace = new Map<string, FeatureEventData[]>();
    for (const ev of all) {
      const key = `${ev.orgId}:${ev.workspaceId}`;
      const list = byWorkspace.get(key) ?? [];
      list.push(ev);
      byWorkspace.set(key, list);
    }

    let totalFilesWritten = 0;

    for (const [groupKey, group] of byWorkspace) {
      const { orgId, workspaceId } = group[0]!;
      // fileNaturalKey → connectionId, for the graph write after the batch ends.
      const connByFile = new Map(
        group.map((g) => [g.fileNaturalKey, g.connectionId]),
      );

      const requests = group.map((g) => ({
        customId: g.fileNaturalKey,
        system: FEATURE_SYSTEM_PROMPT,
        prompt: buildFeaturePrompt(g.fileNaturalKey, g.symbols),
        maxTokens: MAX_OUTPUT_TOKENS,
      }));

      // ── Submit the batch ────────────────────────────────────────────────────
      const submit = await step.run(`submit-${groupKey}`, () =>
        submitBatch({
          model: BATCH_MODEL,
          requests,
          telemetry: { orgId, workspaceId, surface: "ingestion" },
        }),
      );

      // ── Track it in ai.batch_jobs ───────────────────────────────────────────
      await step.run(`track-${groupKey}`, () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx.insert(schema.aiBatchJobs).values({
              orgId,
              workspaceId,
              provider: "anthropic",
              providerBatchId: submit.batchId,
              surface: "ingestion",
              model: BATCH_MODEL,
              status: "submitted",
              requestCount: submit.requestCount,
              submittedAt: new Date(),
              metadata: { kind: "github.feature-inference" },
            }),
          ),
        ),
      );

      // ── Poll to completion ──────────────────────────────────────────────────
      let poll: Awaited<ReturnType<typeof pollBatch>> | undefined;
      for (let i = 0; i < MAX_POLLS; i++) {
        poll = await step.run(`poll-${groupKey}-${i}`, () =>
          pollBatch({
            batchId: submit.batchId,
            model: BATCH_MODEL,
            telemetry: { orgId, workspaceId, surface: "ingestion" },
          }),
        );
        if (poll.ended) break;
        await step.sleep(`wait-${groupKey}-${i}`, POLL_INTERVAL);
      }

      if (!poll || !poll.ended) {
        logger.warn(
          { batchId: submit.batchId, orgId, workspaceId },
          "ingestion-github-infer-features-batch: batch still running after poll cap; tracking row left in_progress",
        );
        await step.run(`mark-inflight-${groupKey}`, () =>
          runInTenantScope({ orgId, workspaceId }, () =>
            updateBatchRow(submit.batchId, { status: "in_progress" }),
          ),
        );
        continue;
      }

      // ── Persist counts + write Feature nodes for succeeded files ─────────────
      await step.run(`finalize-${groupKey}`, () =>
        runInTenantScope({ orgId, workspaceId }, () =>
          updateBatchRow(submit.batchId, {
            status: "ended",
            succeededCount: poll!.counts.succeeded,
            erroredCount: poll!.counts.errored,
            expiredCount: poll!.counts.expired,
            canceledCount: poll!.counts.canceled,
            completedAt: new Date(),
          }),
        ),
      );

      const filesWritten = await step.run(`write-${groupKey}`, () =>
        runInTenantScope({ orgId, workspaceId }, async () => {
          const session = scopedSession();
          let written = 0;
          try {
            for (const r of poll!.results) {
              if (r.type !== "succeeded" || !r.text) continue;
              const features = parseFeaturesFromText(r.text);
              if (features.length === 0) continue;
              const connectionId = connByFile.get(r.customId) ?? "";
              const created = await writeAcceptedFeatures(
                session,
                {
                  orgId,
                  workspaceId,
                  connectionId,
                  fileNaturalKey: r.customId,
                  authority: {
                    method: "llm-feature-inference-batch",
                    model: BATCH_MODEL,
                  },
                },
                features,
              );
              if (created > 0) written += 1;
            }
          } finally {
            await session.close();
          }
          return written;
        }),
      );

      totalFilesWritten += filesWritten;
      logger.info(
        {
          batchId: submit.batchId,
          orgId,
          workspaceId,
          files: group.length,
          filesWritten,
        },
        "ingestion-github-infer-features-batch: batch complete",
      );
    }

    return { batches: byWorkspace.size, filesWritten: totalFilesWritten };
  },
);

/** Update the ai.batch_jobs tracking row for a provider batch id. Best-effort. */
async function updateBatchRow(
  providerBatchId: string,
  patch: Partial<typeof schema.aiBatchJobs.$inferInsert>,
): Promise<void> {
  const { eq } = await import("drizzle-orm");
  await withTenantDb((tx) =>
    tx
      .update(schema.aiBatchJobs)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.aiBatchJobs.providerBatchId, providerBatchId)),
  );
}
