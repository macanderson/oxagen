// embeddings.backfill.ts: gives every node with no vector one (#4148).
//
// Embeddings failed in production for about two days, and ingestion stored
// records without vectors. The move to voyage-3-large then resized every
// vector index to 1,024 dimensions, and the migrator cleared every vector of
// the old size. A node with `n.embedding IS NULL` is invisible to vector
// search and to dedup's similarity pass, and nothing else fills it in.
//
// Two functions over one worker:
//   - `embeddings/backfill-schedule` runs every 30 minutes and sends
//     EMBEDDINGS_BACKFILL_REQUESTED_EVENT.
//   - `embeddings/backfill` runs on that event, one run at a time, so a
//     scheduled run and one an operator requests do not overlap and pay for
//     the same nodes. An operator sends the event from the Inngest dashboard
//     to run a pass now, and each event runs one more pass.
//
// Each run embeds at most MAX_NODES_PER_RUN nodes, in batches of up to
// EMBED_BATCH_SIZE from one workspace, each batch in its own step so a retry
// does not embed a finished batch again. When embeddings are unavailable the
// run stops and logs it, and the next run starts over. Each run writes one
// summary line. Its `missingBefore` and `stillMissing` fields show the set
// shrinking from run to run.

import { EMBEDDING_MODEL } from "@oxagen/ai";
import type { StepContext } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  embedBatch,
  listWorkspaces,
  selectWorkspace,
  type BackfillBatch,
  type WorkspaceSelection,
} from "../lib/embedding-backfill";

/** Send this to run one backfill pass now. The data may be empty. */
export const EMBEDDINGS_BACKFILL_REQUESTED_EVENT =
  "embeddings/backfill.requested";

/** Nodes one run embeds at most. */
export const MAX_NODES_PER_RUN = 2_000;

/** Texts per `embedMany` call, all from one workspace. */
export const EMBED_BATCH_SIZE = 128;

/**
 * Batch steps one run plans at most. Workspaces with a few nodes each make
 * small batches, and this keeps a run's step count well under Inngest's limit.
 */
export const MAX_BATCHES_PER_RUN = 100;

export interface BackfillPlan {
  workspaces: number;
  /** Workspaces whose graph or connections could not be read this run. */
  workspacesFailed: number;
  /** Nodes with no vector that the backfill can embed, before this run. */
  missing: number;
  /** Nodes with no vector that it leaves alone. */
  excluded: number;
  batches: BackfillBatch[];
}

export interface BackfillSummary {
  source: string;
  model: string;
  workspaces: number;
  workspacesFailed: number;
  missingBefore: number;
  excluded: number;
  selected: number;
  embedded: number;
  skipped: number;
  stillMissing: number;
  stoppedEarly: boolean;
}

/**
 * Walk every workspace, count what is missing, and choose this run's nodes.
 * Selection stops at the node cap or the batch cap, and counting goes on to
 * the last workspace so the summary reports the whole set.
 */
export async function planBackfill(): Promise<BackfillPlan> {
  const workspaces = await listWorkspaces();
  const plan: BackfillPlan = {
    workspaces: workspaces.length,
    workspacesFailed: 0,
    missing: 0,
    excluded: 0,
    batches: [],
  };
  let selected = 0;

  for (const scope of workspaces) {
    const capacity = Math.max(
      0,
      Math.min(
        MAX_NODES_PER_RUN - selected,
        (MAX_BATCHES_PER_RUN - plan.batches.length) * EMBED_BATCH_SIZE,
      ),
    );
    let selection: WorkspaceSelection;
    try {
      selection = await selectWorkspace(scope, capacity);
    } catch (err) {
      // A disabled or unreachable data plane throws for its own organisation
      // only. The other workspaces still run.
      plan.workspacesFailed += 1;
      logger.warn(
        { ...scope, err },
        "embeddings.backfill: skipped a workspace whose graph could not be read",
      );
      continue;
    }
    plan.missing += selection.missing;
    plan.excluded += selection.excluded;
    for (let i = 0; i < selection.items.length; i += EMBED_BATCH_SIZE) {
      plan.batches.push({
        ...scope,
        items: selection.items.slice(i, i + EMBED_BATCH_SIZE),
      });
    }
    selected += selection.items.length;
  }
  return plan;
}

export async function runBackfill(
  step: StepContext,
  source: string,
): Promise<BackfillSummary> {
  const plan = await step.run("select-missing", () => planBackfill());

  let embedded = 0;
  let skipped = 0;
  let unavailable: { statusCode: number | null; reason: string } | null =
    null;
  for (const [index, batch] of plan.batches.entries()) {
    const outcome = await step.run(`embed-batch-${index}`, () =>
      embedBatch(batch),
    );
    if (outcome.status === "unavailable") {
      unavailable = { statusCode: outcome.statusCode, reason: outcome.reason };
      break;
    }
    embedded += outcome.embedded;
    skipped += outcome.skipped;
  }

  const summary: BackfillSummary = {
    source,
    model: EMBEDDING_MODEL,
    workspaces: plan.workspaces,
    workspacesFailed: plan.workspacesFailed,
    missingBefore: plan.missing,
    excluded: plan.excluded,
    selected: plan.batches.reduce((n, batch) => n + batch.items.length, 0),
    embedded,
    skipped,
    stillMissing: Math.max(0, plan.missing - embedded - skipped),
    stoppedEarly: unavailable !== null,
  };
  if (unavailable) {
    logger.warn(
      { ...summary, ...unavailable },
      "embeddings.backfill: stopped early because embeddings are unavailable, and the next run tries again",
    );
  } else {
    logger.info(summary, "embeddings.backfill: run complete");
  }
  return summary;
}

function sourceOf(data: Record<string, unknown>): string {
  return typeof data.source === "string" ? data.source : "manual";
}

export const [embeddingsBackfill] = createFunction(
  { id: "embeddings/backfill", retries: 2, concurrency: { limit: 1 } },
  { event: EMBEDDINGS_BACKFILL_REQUESTED_EVENT },
  async ({ event, step }) => runBackfill(step, sourceOf(event.data)),
);

export const [embeddingsBackfillSchedule] = createFunction(
  { id: "embeddings/backfill-schedule", retries: 1 },
  { cron: "*/30 * * * *" },
  async ({ step }) => {
    await step.sendEvent("request-backfill", {
      name: EMBEDDINGS_BACKFILL_REQUESTED_EVENT,
      data: { source: "schedule" },
    });
    return { requested: true };
  },
);
