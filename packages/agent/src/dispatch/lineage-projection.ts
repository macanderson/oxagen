import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, inArray, sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { NodeLabels, EdgeTypes, scopedSession } from "@oxagen/ontology";
import pino from "pino";
import { deriveLineageOutcome } from "./lineage-outcome";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.lineage-projection" },
});

// ── Graph projection of the subagent dispatch tree (issue #1078) ───────────
//
// ARCHITECTURE (do not "improve" this into an inline write — see
// docs/specs/run-evidence-ingress/05-projection-reconciliation-plan.md
// "Global Constraints"): PostgreSQL's agent.subagent_fanouts /
// agent.subagent_runs rows are the chain-of-custody authority. Neo4j is
// disposable and rebuildable — this module reads the CURRENT authoritative
// Postgres state for one fan-out id and idempotently MERGEs the
// corresponding :SubagentFanout / :SubagentRun graph, rather than writing an
// edge inline at each of the dispatch executor's ~11 exit paths (fragile —
// projecting from rows cannot miss one by construction).
//
// Four-store boundary (CLAUDE.md): this module projects STRUCTURE and
// IDENTITY only — node ids, capability names, derived outcome, parent/child
// edges, timestamps. It NEVER writes spend, token counts, or cost — that is
// ClickHouse's, and query_lineage (packages/handlers/src/lineage.query.ts)
// already joins it at read time.
//
// Callers: run at the terminal points only (the Inngest executor's guarded
// finalize branch, and agent.subagent.cancel), best-effort — this function
// throws on failure (Postgres or Neo4j), and it is the CALL SITE's job to
// catch/log and never let a graph failure fail or slow a fanout (mirrors the
// neighboring telemetry emission's `.catch(() => undefined)` pattern).
//
// Self-contained tenant scope: this function opens its own
// runInTenantScope() so it is directly callable from a future backfill
// script with nothing but {fanoutId, orgId, workspaceId} — it does not
// assume the caller already entered scope. Nesting runInTenantScope when the
// caller IS already scoped (e.g. inside kernel.invoke()) is safe: each
// AsyncLocalStorage .run() just shadows the outer store for its duration.

export interface ProjectSubagentFanoutLineageArgs {
  /** agent.subagent_fanouts.id (the internal uuid — NOT the public_id). */
  fanoutId: string;
  orgId: string;
  workspaceId: string;
}

/** One row of the recursive fan-out tree walk (Postgres). */
interface FanoutTreeRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  parent_message_id: string;
  status: string;
  total_children: number;
  completed_children: number;
  created_at: Date;
}

interface RunRow {
  id: string;
  publicId: string;
  fanoutId: string;
  childMessageId: string;
  capabilityName: string;
  status: string;
  errorReason: string | null;
  attempts: number;
  startedAt: Date | null;
  completedAt: Date | null;
}

interface FanoutTree {
  fanouts: FanoutTreeRow[];
  runs: RunRow[];
}

// Defense-in-depth recursion bound. MAX_FANOUT_DEPTH (3) is enforced at
// dispatch time (packages/inngest-functions/src/functions/agent.execute-subagent.ts),
// so real trees never approach this; it only guards against a data anomaly,
// mirroring the `WHERE down.lvl < 10` bound in that same file's descendant count.
const MAX_PROJECTION_DEPTH = 25;

/**
 * Walk the fan-out tree rooted at `fanoutId` — the root fan-out plus every
 * fan-out nested underneath it. Recursion spine (same as
 * packages/handlers/src/lineage.query.ts's walkDispatchTree):
 * subagent_runs.child_message_id = subagent_fanouts.parent_message_id.
 * Reads whatever currently exists regardless of status, by construction —
 * this is how a fan-out that never finalized (child rows exist, fan-out
 * still 'pending') still gets projected.
 */
async function loadFanoutTreeRows(args: {
  fanoutId: string;
  orgId: string;
  workspaceId: string;
}): Promise<FanoutTreeRow[]> {
  const { fanoutId, orgId, workspaceId } = args;
  const result = await withTenantDb((tx) =>
    tx.execute<FanoutTreeRow>(sql`
      WITH RECURSIVE fanout_tree AS (
        SELECT
          f.id, f.public_id, f.parent_message_id, f.status,
          f.total_children, f.completed_children, f.created_at,
          0 AS depth
        FROM agent.subagent_fanouts f
        WHERE f.id = ${fanoutId}::uuid
          AND f.org_id = ${orgId}::uuid
          AND f.workspace_id = ${workspaceId}::uuid

        UNION ALL

        SELECT
          child.id, child.public_id, child.parent_message_id, child.status,
          child.total_children, child.completed_children, child.created_at,
          parent.depth + 1
        FROM fanout_tree parent
        JOIN agent.subagent_runs r
          ON r.fanout_id = parent.id
         AND r.org_id = ${orgId}::uuid
         AND r.workspace_id = ${workspaceId}::uuid
        JOIN agent.subagent_fanouts child
          ON child.parent_message_id = r.child_message_id
         AND child.org_id = ${orgId}::uuid
         AND child.workspace_id = ${workspaceId}::uuid
        WHERE parent.depth < ${MAX_PROJECTION_DEPTH}
      )
      SELECT id, public_id, parent_message_id, status, total_children, completed_children, created_at
      FROM fanout_tree
    `),
  );
  return Array.from(result as unknown as FanoutTreeRow[]);
}

/** Every subagent_runs row belonging to any fan-out in the tree. */
async function loadRunsForFanouts(args: {
  fanoutIds: string[];
  orgId: string;
  workspaceId: string;
}): Promise<RunRow[]> {
  const { fanoutIds, orgId, workspaceId } = args;
  if (fanoutIds.length === 0) return [];
  return withTenantDb((tx) =>
    tx
      .select({
        id: schema.subagentRuns.id,
        publicId: schema.subagentRuns.publicId,
        fanoutId: schema.subagentRuns.fanoutId,
        childMessageId: schema.subagentRuns.childMessageId,
        capabilityName: schema.subagentRuns.capabilityName,
        status: schema.subagentRuns.status,
        errorReason: schema.subagentRuns.errorReason,
        attempts: schema.subagentRuns.attempts,
        startedAt: schema.subagentRuns.startedAt,
        completedAt: schema.subagentRuns.completedAt,
      })
      .from(schema.subagentRuns)
      .where(
        and(
          inArray(schema.subagentRuns.fanoutId, fanoutIds),
          eq(schema.subagentRuns.orgId, orgId),
          eq(schema.subagentRuns.workspaceId, workspaceId),
        ),
      ),
  );
}

async function loadFanoutTree(args: {
  fanoutId: string;
  orgId: string;
  workspaceId: string;
}): Promise<FanoutTree> {
  const fanouts = await loadFanoutTreeRows(args);
  if (fanouts.length === 0) return { fanouts: [], runs: [] };
  const runs = await loadRunsForFanouts({
    fanoutIds: fanouts.map((f) => f.id),
    orgId: args.orgId,
    workspaceId: args.workspaceId,
  });
  return { fanouts, runs };
}

const FANOUT_LABEL = NodeLabels.SubagentFanout;
const RUN_LABEL = NodeLabels.SubagentRun;
const DISPATCHED = EdgeTypes.DISPATCHED;
const SPAWNED_FANOUT = EdgeTypes.SPAWNED_FANOUT;

// Four separate, independently-valid MERGE statements rather than one chained
// multi-UNWIND statement: idempotency is unaffected (each is a plain MERGE on
// a stable key) and each stays trivially reviewable — including the SCOPE_GUARD
// requirement that every statement literally contain the `orgId` token.

const MERGE_FANOUTS_CYPHER = /* cypher */ `
  UNWIND $fanouts AS fo
  MERGE (f:${FANOUT_LABEL} {id: fo.id, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    f:GraphNode,
    f.is_system = true,
    f.label = '${FANOUT_LABEL}',
    f.publicId = fo.publicId,
    f.createdAt = datetime()
  SET
    f.status = fo.status,
    f.totalChildren = fo.totalChildren,
    f.completedChildren = fo.completedChildren,
    f.parentMessageId = fo.parentMessageId,
    f.displayName = fo.displayName,
    f.updatedAt = datetime()
`;

const MERGE_RUNS_CYPHER = /* cypher */ `
  UNWIND $runs AS ru
  MERGE (r:${RUN_LABEL} {id: ru.id, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    r:GraphNode,
    r.is_system = true,
    r.label = '${RUN_LABEL}',
    r.publicId = ru.publicId,
    r.createdAt = datetime()
  SET
    r.capabilityName = ru.capabilityName,
    r.outcome = ru.outcome,
    r.attempts = ru.attempts,
    r.startedAt = datetime(ru.startedAt),
    r.completedAt = datetime(ru.completedAt),
    r.displayName = ru.displayName,
    r.updatedAt = datetime()
`;

const MERGE_DISPATCHED_EDGES_CYPHER = /* cypher */ `
  UNWIND $runs AS ru
  MATCH (f:${FANOUT_LABEL} {id: ru.fanoutId, orgId: $orgId, workspaceId: $workspaceId})
  MATCH (r:${RUN_LABEL} {id: ru.id, orgId: $orgId, workspaceId: $workspaceId})
  MERGE (f)-[:${DISPATCHED}]->(r)
`;

const MERGE_SPAWNED_FANOUT_EDGES_CYPHER = /* cypher */ `
  UNWIND $links AS link
  MATCH (r:${RUN_LABEL} {id: link.runId, orgId: $orgId, workspaceId: $workspaceId})
  MATCH (f:${FANOUT_LABEL} {id: link.childFanoutId, orgId: $orgId, workspaceId: $workspaceId})
  MERGE (r)-[:${SPAWNED_FANOUT}]->(f)
`;

function toIso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/**
 * Resolve, for each run, the id of the nested fan-out it spawned (if any) —
 * a fan-out row whose parent_message_id equals the run's child_message_id.
 * Deterministic earliest-created tie-break when more than one fan-out row
 * shares a parent_message_id (should not happen by construction, but is not
 * DB-enforced) — mirrors packages/handlers/src/lineage.query.ts's
 * walkDispatchTree LATERAL "ORDER BY created_at ASC LIMIT 1".
 */
function buildChildFanoutLinks(
  tree: FanoutTree,
): Array<{ runId: string; childFanoutId: string }> {
  const sortedFanouts = [...tree.fanouts].sort(
    (a, b) => a.created_at.getTime() - b.created_at.getTime(),
  );
  const fanoutIdByParentMessageId = new Map<string, string>();
  for (const f of sortedFanouts) {
    if (!fanoutIdByParentMessageId.has(f.parent_message_id)) {
      fanoutIdByParentMessageId.set(f.parent_message_id, f.id);
    }
  }
  const links: Array<{ runId: string; childFanoutId: string }> = [];
  for (const r of tree.runs) {
    const childFanoutId = fanoutIdByParentMessageId.get(r.childMessageId);
    if (childFanoutId) links.push({ runId: r.id, childFanoutId });
  }
  return links;
}

async function writeLineageGraph(tree: FanoutTree): Promise<void> {
  const fanoutParams = tree.fanouts.map((f) => ({
    id: f.id,
    publicId: f.public_id,
    status: f.status,
    totalChildren: f.total_children,
    completedChildren: f.completed_children,
    parentMessageId: f.parent_message_id,
    displayName: `Fan-out (${f.completed_children}/${f.total_children} completed)`,
  }));

  const runParams = tree.runs.map((r) => ({
    id: r.id,
    publicId: r.publicId,
    fanoutId: r.fanoutId,
    capabilityName: r.capabilityName,
    outcome: deriveLineageOutcome(r.status, r.errorReason),
    attempts: r.attempts,
    startedAt: toIso(r.startedAt),
    completedAt: toIso(r.completedAt),
    displayName: `Run: ${r.capabilityName}`,
  }));

  const childFanoutLinks = buildChildFanoutLinks(tree);

  const s = scopedSession();
  try {
    await s.run(MERGE_FANOUTS_CYPHER, { fanouts: fanoutParams });
    if (runParams.length > 0) {
      await s.run(MERGE_RUNS_CYPHER, { runs: runParams });
      await s.run(MERGE_DISPATCHED_EDGES_CYPHER, { runs: runParams });
    }
    if (childFanoutLinks.length > 0) {
      await s.run(MERGE_SPAWNED_FANOUT_EDGES_CYPHER, {
        links: childFanoutLinks,
      });
    }
  } finally {
    await s.close();
  }
}

/**
 * Project the dispatch tree rooted at `fanoutId` into Neo4j as
 * :SubagentFanout / :SubagentRun nodes joined by :DISPATCHED / :SPAWNED_FANOUT
 * edges. Reads the CURRENT authoritative Postgres state — safe to call
 * repeatedly (idempotent MERGE) and for any fanoutId, including a fan-out
 * that never finalized. No-ops when the fan-out no longer exists (e.g. an id
 * from a torn-down test tenant).
 *
 * Throws on Postgres or Neo4j failure — deliberately NOT swallowed here so a
 * direct/backfill caller sees a real failure signal. The two production call
 * sites (agent.execute-subagent.ts's finalize branch, agent.subagent.cancel)
 * catch and log instead of propagating, per the "never fail or slow a
 * fanout" rule — see the module doc above.
 */
export async function projectSubagentFanoutLineage(
  args: ProjectSubagentFanoutLineageArgs,
): Promise<void> {
  const { fanoutId, orgId, workspaceId } = args;
  await runInTenantScope({ orgId, workspaceId }, async () => {
    const tree = await loadFanoutTree({ fanoutId, orgId, workspaceId });
    if (tree.fanouts.length === 0) {
      logger.warn(
        { fanoutId, orgId },
        "projectSubagentFanoutLineage: fanout not found — nothing to project",
      );
      return;
    }
    await writeLineageGraph(tree);
  });
}
