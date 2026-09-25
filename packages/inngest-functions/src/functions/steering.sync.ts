import { schema, withSystemDb } from "@oxagen/database";
import { NonRetriableError } from "@oxagen/functions";
import { and, eq, isNull, sql } from "drizzle-orm";
import { listDedicatedPlaneScopes } from "../lib/assistant-run-abandon";

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
 * The repository sync for one workspace (ADR-184): make the context registry
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
    const heads = await step.run("list-steered-workspaces", async () => {
      // tenancy: scheduled global sweep across all orgs; both shared-plane
      // reads select only org_id and workspace_id (main binding heads, and
      // legacy GitHub connections with no head), and every sync the sweep
      // requests re-enters that workspace's scope before reading or writing.
      const [bound, legacy, dedicated] = await Promise.all([
        withSystemDb((tx) =>
          tx
            .selectDistinct({
              orgId: schema.repositoryBindingHeads.orgId,
              workspaceId: schema.repositoryBindingHeads.workspaceId,
            })
            .from(schema.repositoryBindingHeads)
            .where(eq(schema.repositoryBindingHeads.role, "main")),
        ),
        // tenancy: scheduled global sweep across all orgs; a workspace the
        // legacy sources wizard connected has no binding head, only a live
        // GitHub connection naming owner and repo. Only org_id and
        // workspace_id are read, and the sync re-enters that scope.
        withSystemDb((tx) =>
          tx
            .selectDistinct({
              orgId: schema.sourceConnections.orgId,
              workspaceId: schema.sourceConnections.workspaceId,
            })
            .from(schema.sourceConnections)
            .where(
              and(
                eq(schema.sourceConnections.connectorId, "github"),
                eq(schema.sourceConnections.status, "connected"),
                isNull(schema.sourceConnections.deletedAt),
                sql`${schema.sourceConnections.deliveryConfig} ->> 'owner' is not null`,
                sql`${schema.sourceConnections.deliveryConfig} ->> 'repo' is not null`,
                sql`not exists (select 1 from ${schema.repositoryBindingHeads} h where h.workspace_id = ${schema.sourceConnections.workspaceId} and h.role = 'main')`,
              ),
            ),
        ),
        // An organization on a dedicated Postgres plane (ADR-042) keeps its
        // binding heads there, out of both reads above. Every workspace of
        // one is asked; a workspace with no main repository answers
        // no_repository and writes nothing.
        listDedicatedPlaneScopes(),
      ]);
      const all = new Map<string, { orgId: string; workspaceId: string }>();
      for (const h of [...bound, ...legacy, ...dedicated])
        all.set(h.workspaceId, { orgId: h.orgId, workspaceId: h.workspaceId });
      return [...all.values()];
    });
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
