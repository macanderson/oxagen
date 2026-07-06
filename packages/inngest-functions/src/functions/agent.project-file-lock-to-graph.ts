import { createFunction } from "../create-function";
import { projectFileLockToGraph } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import { logger } from "../logger";

/**
 * Async LINEAGE projection of a Postgres file lease into Neo4j (ADR-021 §5).
 *
 * Triggered fire-and-forget by the file-lock lease (`@oxagen/agent`'s
 * `file-lock/lease.ts`) on every acquire/release. MERGEs an
 * `(:Agent)-[:LOCKED]->(:SourceFile)` edge for hot-file analytics and conflict
 * prediction (the planner reads the projection to shard work so locks are
 * rarely contended). This is a DERIVED graph index — the lock authority is the
 * Postgres lease, never this edge. Idempotent (MERGE), so retries never
 * duplicate. Concurrency-capped per org to protect the AuraDB pool.
 */
export const [agentProjectFileLockToGraph] = createFunction(
  {
    id: "agent.project-file-lock-to-graph",
    retries: 5,
    concurrency: { limit: 4, key: "event.data.orgId" },
  },
  { event: "agent/file-lock.projected" },
  async ({ event, step }) => {
    const { orgId, workspaceId, resourceKey, holder, executionId, action, event: lockEvent, fencingToken, expiresAt } =
      event.data as {
        orgId: string;
        workspaceId: string;
        resourceKey: string;
        holder: string;
        executionId: string;
        action: string;
        event: "acquired" | "released";
        fencingToken?: number;
        expiresAt?: number;
      };

    await step.run("project-lock-edge", () =>
      runInTenantScope({ orgId, workspaceId }, () =>
        projectFileLockToGraph({
          resourceKey,
          holder,
          executionId,
          action,
          event: lockEvent,
          fencingToken,
          expiresAt,
        }),
      ),
    );

    logger.info({ orgId, resourceKey, holder, event: lockEvent }, "agent.project-file-lock-to-graph: projected");
    return { resourceKey, event: lockEvent, projected: true };
  },
);
