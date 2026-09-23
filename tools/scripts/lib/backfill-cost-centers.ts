/**
 * The pure loop behind `backfill-cost-centers.ts` (ADR-142): page through the
 * runs a live cost-center label now claims, and ask the rollup job to rebuild
 * each one. Everything that touches a store is a dependency, so the loop is
 * tested without one.
 */
import type { UnassignedCostCenterRun } from "@oxagen/billing";

/** The event `cost.run-rollup` subscribes to, in the shape the tacho ingest handler sends. */
export const RUN_SEALED_EVENT = "cost/run.sealed";

export interface RunSealedEvent {
  name: typeof RUN_SEALED_EVENT;
  data: { runId: string; orgId: string; workspaceId: string };
}

export interface BackfillDeps {
  /** One page of the runs to rebuild, after the cursor. */
  list: (args: {
    limit: number;
    after?: UnassignedCostCenterRun;
    orgId?: string;
  }) => Promise<UnassignedCostCenterRun[]>;
  /** Ships one page of rebuild requests. */
  send: (events: RunSealedEvent[]) => Promise<void>;
  /** Where one line of progress goes. */
  log: (line: string) => void;
}

export interface BackfillArgs {
  /** Narrow the pass to one organization. */
  orgId?: string;
  /** False lists and reports; true also sends. */
  apply: boolean;
  /** Runs per page and per send. */
  pageSize: number;
  /** Stop after this many runs, so a first pass can be small. */
  maxRuns: number;
}

export interface BackfillReport {
  /** Runs a live label now claims. */
  listed: number;
  /** Rebuild requests that were sent. Zero on a dry run. */
  requested: number;
  /** Pages whose send threw; those runs stay unassigned and a rerun lists them again. */
  failedPages: number;
  /** True when `maxRuns` stopped the pass before the list ended. */
  truncated: boolean;
}

/**
 * Lists the runs and, on `apply`, sends one `cost/run.sealed` per run in
 * pages. The rollup job rebuilds the run row from its frames, the way a seal
 * does, then the workspace-day's daily totals, so the Spend page and the
 * statement move together. A page whose send fails is counted and the loop
 * goes on: the runs it held are still unassigned and a rerun lists them again,
 * which is the recovery.
 *
 * The cursor is the last row of each page, never the head of the list, so a
 * run the rebuild leaves unassigned (its agent has no principal, say) cannot
 * be listed twice in one pass.
 */
export async function backfillCostCenters(
  args: BackfillArgs,
  deps: BackfillDeps,
): Promise<BackfillReport> {
  const report: BackfillReport = {
    listed: 0,
    requested: 0,
    failedPages: 0,
    truncated: false,
  };
  let after: UnassignedCostCenterRun | undefined;
  for (;;) {
    const remaining = args.maxRuns - report.listed;
    if (remaining <= 0) {
      const more = await deps.list({ limit: 1, after, orgId: args.orgId });
      report.truncated = more.length > 0;
      break;
    }
    const page = await deps.list({
      limit: Math.min(args.pageSize, remaining),
      after,
      orgId: args.orgId,
    });
    if (page.length === 0) break;
    report.listed += page.length;
    after = page[page.length - 1];
    for (const run of page) {
      deps.log(
        `${args.apply ? "request" : "would request"} ${run.runId} (started ${run.startedAt}, workspace ${run.workspaceId})`,
      );
    }
    if (!args.apply) continue;
    try {
      await deps.send(
        page.map((run) => ({
          name: RUN_SEALED_EVENT,
          data: {
            runId: run.runId,
            orgId: run.orgId,
            workspaceId: run.workspaceId,
          },
        })),
      );
      report.requested += page.length;
    } catch (err) {
      report.failedPages += 1;
      deps.log(
        `send failed for ${page.length} run(s) from ${page[0]!.runId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return report;
}
