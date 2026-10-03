// similarity.reconcile.ts: runs dedup's similarity pass for entities that
// ingestion wrote without it (#4148).
//
// When the embedder or the vector index is down, ingestion writes each new
// entity as its own principal and marks it `similarityDeferredAt`. The record
// is kept, but it may duplicate a node that already exists. The embedding
// backfill (`embeddings.backfill.ts`) gives the node a vector. This job then
// searches with that vector and links the node to its match with an
// `ALIAS_OF` edge, the way ingestion would have
// (`@oxagen/ingestion/dedup/reconcile`).
//
// It runs every 30 minutes, 15 minutes after each backfill run, one run at a
// time. Each run reconciles at most MAX_NODES_PER_RUN nodes, in batches of up
// to RECONCILE_BATCH_SIZE from one workspace, each batch in its own step. A
// retried step is safe: a reconciled node no longer carries the mark, and a
// node that already has an `ALIAS_OF` edge gets no second one. A node with no
// vector keeps its mark and waits for the backfill. A node whose connection
// opted out of embedding never gets one, so it stays in `withoutVector`. Each
// run writes one summary line.

import type { StepContext } from "@oxagen/functions";
import {
  findDeferredNodes,
  reconcileDeferredNode,
  type DeferredSelection,
  type ReconcileOutcome,
} from "@oxagen/ingestion/dedup/reconcile";
import { runInTenantScope } from "@oxagen/tenancy";
import { createFunction } from "../create-function";
import { logger } from "../logger";
import { listWorkspaces, type WorkspaceScope } from "../lib/embedding-backfill";

/** Nodes one run reconciles at most. */
export const MAX_NODES_PER_RUN = 500;

/**
 * Nodes per step, all from one workspace. Each node costs up to four graph
 * queries, so a batch stays well inside one step's time.
 */
export const RECONCILE_BATCH_SIZE = 25;

/** One step's nodes. One workspace, so one tenant scope. */
export interface ReconcileBatch extends WorkspaceScope {
  ids: string[];
}

export interface ReconcilePlan {
  workspaces: number;
  /** Workspaces whose graph could not be read this run. */
  workspacesFailed: number;
  /** Nodes that carry the mark, before this run. */
  deferred: number;
  /** Marked nodes with no vector yet, which this run leaves alone. */
  withoutVector: number;
  batches: ReconcileBatch[];
}

/** How many nodes ended in each outcome. */
export interface ReconcileTally {
  linked: number;
  unmatched: number;
  alreadyLinked: number;
  noVector: number;
  notDeferred: number;
  searchFailed: number;
}

export interface ReconcileSummary extends ReconcileTally {
  workspaces: number;
  workspacesFailed: number;
  deferredBefore: number;
  withoutVector: number;
  selected: number;
  /** Marked nodes left after this run. */
  stillDeferred: number;
}

function emptyTally(): ReconcileTally {
  return {
    linked: 0,
    unmatched: 0,
    alreadyLinked: 0,
    noVector: 0,
    notDeferred: 0,
    searchFailed: 0,
  };
}

function tallyOutcome(tally: ReconcileTally, outcome: ReconcileOutcome): void {
  switch (outcome.status) {
    case "linked":
      tally.linked += 1;
      return;
    case "unmatched":
      tally.unmatched += 1;
      return;
    case "already_linked":
      tally.alreadyLinked += 1;
      return;
    case "no_vector":
      tally.noVector += 1;
      return;
    case "not_deferred":
      tally.notDeferred += 1;
      return;
    case "search_failed":
      tally.searchFailed += 1;
      return;
  }
}

/**
 * Walk every workspace, count its marked nodes, and choose this run's nodes.
 * Selection stops at the node cap, and counting goes on to the last workspace
 * so the summary reports the whole set.
 */
export async function planReconcile(): Promise<ReconcilePlan> {
  const workspaces = await listWorkspaces();
  const plan: ReconcilePlan = {
    workspaces: workspaces.length,
    workspacesFailed: 0,
    deferred: 0,
    withoutVector: 0,
    batches: [],
  };
  let selected = 0;

  for (const scope of workspaces) {
    let selection: DeferredSelection;
    try {
      selection = await runInTenantScope(scope, () =>
        findDeferredNodes(Math.max(0, MAX_NODES_PER_RUN - selected)),
      );
    } catch (err) {
      // A disabled or unreachable data plane throws for its own organisation
      // only. The other workspaces still run.
      plan.workspacesFailed += 1;
      logger.warn(
        { ...scope, err },
        "similarity.reconcile: skipped a workspace whose graph could not be read",
      );
      continue;
    }
    plan.deferred += selection.deferred;
    plan.withoutVector += selection.withoutVector;
    for (let i = 0; i < selection.ids.length; i += RECONCILE_BATCH_SIZE) {
      plan.batches.push({
        ...scope,
        ids: selection.ids.slice(i, i + RECONCILE_BATCH_SIZE),
      });
    }
    selected += selection.ids.length;
  }
  return plan;
}

/** Reconcile one batch in its workspace's tenant scope. */
export function reconcileBatch(batch: ReconcileBatch): Promise<ReconcileTally> {
  const { orgId, workspaceId } = batch;
  return runInTenantScope({ orgId, workspaceId }, async () => {
    const tally = emptyTally();
    for (const id of batch.ids) {
      const outcome = await reconcileDeferredNode(id, orgId);
      tallyOutcome(tally, outcome);
      if (outcome.status === "search_failed") {
        logger.warn(
          { orgId, workspaceId, nodeId: id, err: outcome.error },
          "similarity.reconcile: the vector index refused the search, and the node keeps its mark for the next run",
        );
      }
    }
    return tally;
  });
}

export async function runReconcile(
  step: StepContext,
): Promise<ReconcileSummary> {
  const plan = await step.run("select-deferred", () => planReconcile());

  const tally = emptyTally();
  for (const [index, batch] of plan.batches.entries()) {
    const done = await step.run(`reconcile-batch-${index}`, () =>
      reconcileBatch(batch),
    );
    tally.linked += done.linked;
    tally.unmatched += done.unmatched;
    tally.alreadyLinked += done.alreadyLinked;
    tally.noVector += done.noVector;
    tally.notDeferred += done.notDeferred;
    tally.searchFailed += done.searchFailed;
  }

  // These outcomes clear the mark. The rest leave it for the next run.
  const cleared = tally.linked + tally.unmatched + tally.alreadyLinked;
  const summary: ReconcileSummary = {
    workspaces: plan.workspaces,
    workspacesFailed: plan.workspacesFailed,
    deferredBefore: plan.deferred,
    withoutVector: plan.withoutVector,
    selected: plan.batches.reduce((n, batch) => n + batch.ids.length, 0),
    ...tally,
    stillDeferred: Math.max(0, plan.deferred - cleared - tally.notDeferred),
  };
  logger.info(summary, "similarity.reconcile: run complete");
  return summary;
}

export const [similarityReconcile] = createFunction(
  { id: "similarity/reconcile", retries: 2, concurrency: { limit: 1 } },
  { cron: "15,45 * * * *" },
  async ({ step }) => runReconcile(step),
);
