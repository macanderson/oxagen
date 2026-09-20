import { listWorkspacesForFindings, runFindingsPass } from "@oxagen/billing";
import { NonRetriableError } from "@oxagen/functions";
import { createFunction } from "../create-function";
import { logger } from "../logger";

type Scope = { orgId: string; workspaceId: string };

/** The workspaces a batch of `cost/findings.requested` events names, once each. */
export function scopesOf(events: readonly { data: unknown }[]): Scope[] {
  const scopes = new Map<string, Scope>();
  for (const e of events) {
    const d = e.data as Partial<Scope>;
    if (typeof d.orgId === "string" && typeof d.workspaceId === "string")
      scopes.set(d.workspaceId, { orgId: d.orgId, workspaceId: d.workspaceId });
  }
  return [...scopes.values()];
}

/**
 * `cost/findings.requested` → one findings pass per workspace (Mission
 * Control spec §12.8; ADR-062 §4). The run rollup sends the event after each
 * sealed run's row lands. Events batch per workspace, up to five per run or
 * thirty seconds, so a burst of seals costs one pass per five runs rather than
 * one per run. Both bounds are the most Inngest accepts, and both are checked
 * at build time by `MAX_BATCH_SIZE` and `MAX_BATCH_TIMEOUT_SECONDS`: either
 * one over its limit makes Inngest refuse the whole app's sync, which leaves
 * every function in the app unregistered. A degraded store throws, and Inngest
 * retries the batch.
 */
export const [costFindings] = createFunction(
  {
    id: "cost.findings",
    retries: 3,
    batchEvents: {
      maxSize: 5,
      timeout: "30s",
      key: "event.data.workspaceId",
    },
  },
  { event: "cost/findings.requested" },
  async ({ events, step }) => {
    const scopes = scopesOf(events ?? []);
    if (scopes.length === 0)
      throw new NonRetriableError(
        "cost/findings.requested carries no orgId and workspaceId",
      );
    let findings = 0;
    for (const scope of scopes) {
      const out = await step.run(`findings-${scope.workspaceId}`, () =>
        runFindingsPass(scope),
      );
      findings += out.findings;
    }
    logger.info(
      { workspaces: scopes.length, findings },
      "cost.findings complete",
    );
    return { workspaces: scopes.length, findings };
  },
);

/**
 * Nightly at 02:00 UTC, after the 01:00 rollup: a findings pass over every
 * workspace with a run row in the trailing window or an open finding, so
 * findings age out with their runs (a workspace whose runs stopped gets a pass
 * with no runs, which deletes its open findings) and a workspace whose request
 * event was lost is still visited.
 * One workspace's degraded read does not stop the sweep; the next night
 * retries it.
 */
export const [costFindingsNightly] = createFunction(
  { id: "cost.findings-nightly", retries: 3 },
  { cron: "0 2 * * *" },
  async ({ step }) => {
    const scopes = await step.run("list-workspaces", () =>
      listWorkspacesForFindings(new Date()),
    );
    let passed = 0;
    for (const scope of scopes) {
      const ok = await step.run(`findings-${scope.workspaceId}`, async () => {
        try {
          await runFindingsPass(scope);
          return true;
        } catch (err) {
          logger.warn(
            { workspaceId: scope.workspaceId, err },
            "cost.findings-nightly: pass failed",
          );
          return false;
        }
      });
      if (ok) passed += 1;
    }
    logger.info(
      { workspaces: scopes.length, passed },
      "cost.findings-nightly complete",
    );
    return { workspaces: scopes.length, passed };
  },
);
