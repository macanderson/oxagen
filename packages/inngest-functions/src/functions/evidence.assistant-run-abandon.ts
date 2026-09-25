import { createFunction } from "../create-function";
import {
  abandonCutoff,
  abandonSilentAssistantRuns,
  type AbandonedAssistantRun,
  listDedicatedPlaneScopes,
} from "../lib/assistant-run-abandon";
import { logger } from "../logger";

/**
 * Runs closed per plane in one pass. A deploy that kills many turns at once
 * leaves a backlog, and it drains this many every five minutes.
 */
export const ABANDON_BATCH = 200;

/**
 * The dedup id of one run's rollup request. The close is a compare-and-set,
 * so a run is abandoned once, and a retried send of the same request is
 * dropped by the provider rather than rolled up twice.
 */
export function abandonedRollupEventId(runPublicId: string): string {
  return `cost-run-sealed:${runPublicId}:abandoned`;
}

/**
 * Every five minutes: seal the in-app assistant runs whose process died
 * mid-turn, and roll up each one's cost as final (#3988).
 *
 * Before this, nothing sealed a ledger run but the turn that opened it, so a
 * deploy, an OOM or a crash mid-turn left the run live on Fleet for good and
 * out of every cost rollup. The rule and why a live turn always wins are in
 * `../lib/assistant-run-abandon.ts`.
 *
 * The shared plane is scanned once. Each workspace of an organization on a
 * dedicated plane (ADR-042) is scanned in its own scope and its own step, as
 * `approval/resume` does, so one unreachable plane is logged and the rest go
 * ahead. Each run closes in its own transaction.
 */
export const [evidenceAssistantRunAbandon] = createFunction(
  {
    id: "evidence.assistant-run-abandon",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    const scopes = await step.run(
      "find-dedicated-workspaces",
      listDedicatedPlaneScopes,
    );
    const dedicatedOrgIds = [...new Set(scopes.map((s) => s.orgId))];

    const shared = await step.run("abandon-shared-plane", () =>
      abandonSilentAssistantRuns({
        cutoff: abandonCutoff(new Date()),
        limit: ABANDON_BATCH,
        excludeOrgIds: dedicatedOrgIds,
      }),
    );
    let found = shared.found;
    const abandoned: AbandonedAssistantRun[] = [...shared.abandoned];

    for (const scope of scopes) {
      try {
        const pass = await step.run(`abandon-${scope.workspaceId}`, () =>
          abandonSilentAssistantRuns({
            cutoff: abandonCutoff(new Date()),
            limit: ABANDON_BATCH,
            scope,
          }),
        );
        found += pass.found;
        abandoned.push(...pass.abandoned);
      } catch (err) {
        logger.error(
          { err, workspaceId: scope.workspaceId },
          "evidence.assistant-run-abandon: a dedicated plane could not be swept",
        );
      }
    }

    if (abandoned.length > 0) {
      await step.sendEvent(
        "request-rollups",
        abandoned.map((run) => ({
          name: "cost/run.sealed",
          id: abandonedRollupEventId(run.publicId),
          data: {
            runId: run.publicId,
            orgId: run.orgId,
            workspaceId: run.workspaceId,
          },
        })),
      );
    }

    logger.info(
      { found, abandoned: abandoned.length, dedicatedScopes: scopes.length },
      "evidence.assistant-run-abandon complete",
    );
    return { found, abandoned: abandoned.length };
  },
);
