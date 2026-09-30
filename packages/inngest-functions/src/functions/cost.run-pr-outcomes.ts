// cost.run-pr-outcomes: keep `cost.run_pr_outcomes` current (#4491).
//
// Two functions write the table:
//
//   1. An hourly refresh visits every workspace with a sealed run in the
//      trailing 30 days. It writes a row for each pull request a run opened,
//      reads the state, CI, and head branch of the ones not yet settled from
//      GitHub, and gives a run with no pull request one row with its terminal
//      reason. The GitHub reads live in `@oxagen/handlers`, behind the runner
//      seam in `lib/run-pr-outcomes-runner.ts`.
//   2. A delivery function folds each GitHub pull request and pushed commit
//      the app already receives (`ingestion/entity.received`) into the rows:
//      a pull request's new state, and the reverts a merged pull request body
//      or a `git revert` commit records.
//
// Both keep each revert in `cost.run_pr_reverts` before they write a row, and
// every refresh pass marks its rows with the reverts kept there. A revert can
// arrive before the refresh writes the row it reverts. The hourly function
// deletes the reverts Oxagen saw more than a day before the window opens.
import {
  applyOutcomeDelivery,
  listWorkspacesForOutcomes,
  OUTCOME_WINDOW_DAYS,
  outcomeDeliveryOf,
  pruneRevertEvidence,
} from "@oxagen/billing";
import { createFunction } from "../create-function";
import {
  type RunPrOutcomesResult,
  runPrOutcomesRunner,
} from "../lib/run-pr-outcomes-runner";
import { logger } from "../logger";

/** A kept revert outlives the window by one day, so no pass misses one at its edge. */
const REVERT_RETENTION_MS = (OUTCOME_WINDOW_DAYS + 1) * 24 * 60 * 60 * 1000;

/**
 * Hourly at 15 past: one refresh pass per workspace with a sealed run in the
 * window, then one delete of the kept reverts older than the window. One
 * workspace's failed pass does not stop the sweep, and the next hour retries
 * it.
 */
export const [costRunPrOutcomesHourly] = createFunction(
  { id: "cost.run-pr-outcomes-hourly", retries: 2 },
  { cron: "15 * * * *" },
  async ({ step }) => {
    const scopes = await step.run("list-workspaces", () =>
      listWorkspacesForOutcomes(new Date()),
    );
    let passed = 0;
    let rows = 0;
    for (const scope of scopes) {
      const out = await step.run(
        `outcomes-${scope.workspaceId}`,
        async (): Promise<RunPrOutcomesResult | null> => {
          try {
            return await runPrOutcomesRunner()(scope);
          } catch (err) {
            logger.warn(
              { workspaceId: scope.workspaceId, err },
              "cost.run-pr-outcomes-hourly: pass failed",
            );
            return null;
          }
        },
      );
      if (out === null) continue;
      passed += 1;
      rows += out.rows;
    }
    const pruned = await step.run("prune-reverts", () =>
      pruneRevertEvidence(new Date(Date.now() - REVERT_RETENTION_MS)),
    );
    logger.info(
      { workspaces: scopes.length, passed, rows, pruned },
      "cost.run-pr-outcomes-hourly complete",
    );
    return { workspaces: scopes.length, passed, rows, pruned };
  },
);

/** The fields of an `ingestion/entity.received` event this function reads. */
interface EntityReceived {
  orgId?: unknown;
  workspaceId?: unknown;
  connectorType?: unknown;
  sourceRecordType?: unknown;
  payload?: unknown;
}

/**
 * Each GitHub pull request or commit delivery → the outcome rows it changes.
 * Every ingestion event starts a run, since a trigger cannot filter on the
 * payload. A run for any other record returns before it opens a step.
 */
export const [costRunPrOutcomesDelivery] = createFunction(
  {
    id: "cost.run-pr-outcomes-delivery",
    retries: 3,
    concurrency: [{ limit: 2 }, { limit: 5, key: "event.data.orgId" }],
  },
  { event: "ingestion/entity.received" },
  async ({ event, step }) => {
    const data = event.data as EntityReceived;
    if (
      data.connectorType !== "github" ||
      typeof data.orgId !== "string" ||
      typeof data.workspaceId !== "string" ||
      typeof data.sourceRecordType !== "string"
    )
      return { applied: false };
    const delivery = outcomeDeliveryOf(
      data.sourceRecordType,
      data.payload,
      new Date(),
    );
    if (delivery === null) return { applied: false };
    // A commit that reverts nothing changes no row, and most commits do not.
    if (
      delivery.kind === "commit" &&
      !/This reverts commit [0-9a-f]{40}/i.test(delivery.message)
    )
      return { applied: false };
    const scope = { orgId: data.orgId, workspaceId: data.workspaceId };
    const out = await step.run("apply-delivery", () =>
      applyOutcomeDelivery(scope, delivery),
    );
    return { applied: true, ...out };
  },
);
