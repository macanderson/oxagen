import { schema, withSystemDb } from "@oxagen/database";
import { NonRetriableError } from "@oxagen/functions";
import { eq } from "drizzle-orm";
import { createFunction } from "../create-function";
import { steeringSyncRunner } from "../lib/steering-sync-runner";

/**
 * One sync, with a refusal the runner marked non-retriable (the production
 * branch is gone, the rules directory is too large) rethrown as the error
 * Inngest recognises inside a step. The flag alone is read only outside the
 * step, after Inngest has already retried the step to exhaustion.
 */
async function runOnce(
  scope: { orgId: string; workspaceId: string },
  force: boolean,
) {
  try {
    return await steeringSyncRunner()(scope, { force });
  } catch (err) {
    if (
      err !== null &&
      typeof err === "object" &&
      (err as { isNonRetriable?: unknown }).isNonRetriable === true
    )
      throw new NonRetriableError(
        err instanceof Error ? err.message : String(err),
        { cause: err },
      );
    throw err;
  }
}

/**
 * The repository sync for one workspace (ADR-182): make the context registry
 * match the record files on the main repository's production branch.
 *
 * The GitHub and GitLab webhooks send `steering/sync.requested` on a push or a
 * merge, and the sweep below sends it every five minutes. Deliveries for one
 * workspace are debounced, so a squash merge's push and its `pull_request`
 * event run one sync, and never run two at once.
 */
export const [steeringSync] = createFunction(
  {
    id: "steering/sync",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.workspaceId" },
    debounce: {
      period: "3s",
      key: "event.data.workspaceId",
      timeout: "30s",
    },
  },
  { event: "steering/sync.requested" },
  async ({ event, step }) => {
    const data = event.data as {
      orgId: string;
      workspaceId: string;
      force?: boolean;
    };
    const scope = { orgId: data.orgId, workspaceId: data.workspaceId };
    const first = await step.run("sync", () =>
      runOnce(scope, data.force === true),
    );
    if (first.retryAfterSeconds === null) return first;
    // A Context PR Oxagen merged is still inside its grace window; the merge
    // publishes it with its reviewer on the ledger. Sync again after the
    // window, when anything the merge left unpublished is the sync's.
    await step.sleep("merge-grace", `${first.retryAfterSeconds}s`);
    return step.run("sync-after-grace", () => runOnce(scope, true));
  },
);

/**
 * Every five minutes, a sync for every workspace with a main repository. It
 * catches a webhook delivery that never arrived; a sync whose branch head has
 * not moved reads nothing more.
 */
export const [steeringSyncSweep] = createFunction(
  { id: "steering/sync-sweep", retries: 1, concurrency: { limit: 1 } },
  { cron: "*/5 * * * *" },
  async ({ step }) => {
    // tenancy: scheduled global sweep across all orgs; it reads only the
    // org_id and workspace_id of each main binding head, and every sync it
    // requests re-enters that workspace's scope before reading or writing.
    const heads = await step.run("list-main-repositories", () =>
      withSystemDb((tx) =>
        tx
          .selectDistinct({
            orgId: schema.repositoryBindingHeads.orgId,
            workspaceId: schema.repositoryBindingHeads.workspaceId,
          })
          .from(schema.repositoryBindingHeads)
          .where(eq(schema.repositoryBindingHeads.role, "main")),
      ),
    );
    if (heads.length === 0) return { requested: 0 };
    await step.sendEvent(
      "request-syncs",
      heads.map((h) => ({
        name: "steering/sync.requested",
        data: { orgId: h.orgId, workspaceId: h.workspaceId, reason: "sweep" },
      })),
    );
    return { requested: heads.length };
  },
);
