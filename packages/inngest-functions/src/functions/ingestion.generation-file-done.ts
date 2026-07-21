import { createFunction } from "../create-function";
import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { activateGenerationIfComplete } from "../lib/github-projection";
import { logger } from "../logger";

/**
 * Generation file-done Inngest function.
 *
 * Triggered by "ingestion/github.generation-file-done", emitted by parse-file
 * after each file in a projection generation finishes (or is skipped). It:
 *   1. atomically advances the generation's files_processed / files_skipped
 *      counter via a SINGLE `UPDATE … RETURNING` — never a read-modify-write.
 *      Postgres takes the row lock for the duration of the statement and each
 *      concurrent statement re-reads the committed value, so hundreds of
 *      parallel file-done events increment exactly once each and every one
 *      sees a distinct post-increment total in its RETURNING row;
 *   2. calls activateGenerationIfComplete only when ITS returned counters
 *      reach files_total (spec §"GitHub projection lifecycle") — so exactly one
 *      event, the last one to commit, attempts activation. This is an
 *      optimization, not the safety guard: activateGenerationIfComplete
 *      re-checks the gate under the repository-row lock, so a duplicated or
 *      out-of-order attempt still stands down.
 *
 * The counter increment is its OWN memoized step, separate from and before
 * activation, so an activation retry never re-runs (and thus never double-counts)
 * the increment.
 *
 * Concurrency is intentionally UNBOUNDED per generation — the atomic UPDATE and
 * the repository-row-locked activation serialize correctly under contention.
 */
export const [ingestionGenerationFileDone] = createFunction(
  {
    id: "ingestion-generation-file-done",
    retries: 3,
  },
  { event: "ingestion/github.generation-file-done" },
  async ({ event, step }) => {
    const { orgId, workspaceId, generationId, skipped } = event.data as {
      orgId: string;
      workspaceId: string;
      generationId: string;
      skipped: boolean;
    };

    // ── Step 1: Atomically advance the completion counter ─────────────────────
    // One statement, no prior SELECT: `col = col + 1` is evaluated against the
    // row Postgres holds locked for this UPDATE, so concurrent events cannot
    // lose an increment. RETURNING hands back THIS event's post-increment view.
    const counters = await step.run("increment-counter", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        withTenantDb(async (tx) => {
          const rows = Array.from(
            await tx.execute(
              skipped
                ? sql`
                    UPDATE ingestion.projection_generations
                    SET files_skipped = files_skipped + 1, updated_at = NOW()
                    WHERE id = ${generationId}::uuid
                    RETURNING files_total, files_processed, files_skipped
                  `
                : sql`
                    UPDATE ingestion.projection_generations
                    SET files_processed = files_processed + 1, updated_at = NOW()
                    WHERE id = ${generationId}::uuid
                    RETURNING files_total, files_processed, files_skipped
                  `,
            ),
          ) as Array<{
            files_total: number;
            files_processed: number;
            files_skipped: number;
          }>;
          return rows[0] ?? null;
        }),
      ),
    );

    // The generation row is gone (erased tenant / manual cleanup) — nothing to
    // count toward and nothing to activate.
    if (!counters) {
      logger.warn(
        { orgId, workspaceId, generationId },
        "ingestion-generation-file-done: generation row not found",
      );
      return { generationId, skipped, activated: false };
    }

    const complete =
      Number(counters.files_processed) + Number(counters.files_skipped) >=
      Number(counters.files_total);

    // ── Step 2: Activate the generation if THIS event completed it ────────────
    // Only the event whose own increment closed the gate attempts activation;
    // activateGenerationIfComplete still re-checks under the repository-row lock.
    if (!complete) {
      return { generationId, skipped, activated: false };
    }

    const result = await step.run("activate-if-complete", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        activateGenerationIfComplete(generationId),
      ),
    );

    if (result.activated) {
      logger.info(
        { orgId, workspaceId, generationId, commitSha: result.commitSha },
        "ingestion-generation-file-done: generation activated",
      );
    }

    return { generationId, skipped, activated: result.activated };
  },
);
