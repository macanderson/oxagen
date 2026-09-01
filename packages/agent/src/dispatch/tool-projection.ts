import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { NodeLabels, EdgeTypes, scopedSession } from "@oxagen/ontology";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.tool-projection" },
});

// ── Graph projection of the tools one execution invoked ─────────────────────
//
// ARCHITECTURE (mirrors ./lineage-projection.ts — do not "improve" this into
// an inline write): PostgreSQL's agent.agent_tool_calls rows are the
// authority. Neo4j is disposable and rebuildable, so this module reads the
// CURRENT authoritative Postgres state for one execution id and idempotently
// MERGEs the corresponding :Tool graph, rather than writing an INVOKED edge
// at each site that dispatches a tool. Projecting from rows cannot miss an
// exit path by construction.
//
// WHY POSTGRES FOR BOTH IDENTITY AND USAGE. The four-store boundary puts
// identity in Postgres and usage counters in ClickHouse, and for tools both
// halves are Postgres today — not by preference but because ClickHouse's
// tool-usage record cannot be joined to an execution. `tool_invocations`
// declares an `execution_step_id` column, and every one of its seven
// producers writes NULL into it (materialize-tools.ts's
// buildInvocationPayload, graph.telemetry.ts, and the five inngest-functions
// emitters). agent.agent_tool_calls.execution_step_id, by contrast, is a NOT
// NULL foreign key to agent.agent_execution_steps, whose execution_id is the
// join this projection exists to make queryable. So agent_tool_calls is the
// only execution-joinable tool record in the system, and it carries the tool
// name and type as columns.
//
// Four-store boundary (CLAUDE.md): this module projects STRUCTURE and
// IDENTITY only — tool name, tool type, call counts, timestamps. It NEVER
// writes spend, token counts, or cost, even though agent_tool_calls carries
// input_tokens/output_tokens beside the columns read here. Those are
// ClickHouse's and are joined at read time.
//
// NO :ToolVersion NODE IS WRITTEN, and INVOKED therefore points at :Tool.
// packages/ontology/src/schema.cypher records the edge as
// :Execution -> :ToolVersion, which was written against agent.tool_versions —
// a table dropped as dead in
// packages/database/drizzle/migration_archive/0004_drop_dead_tables.sql
// ("no domain reads/writes; e2e fixture only"). Nothing in the tree records a
// tool version any more, so a :ToolVersion node here would carry a fabricated
// version. A tool's identity as this repository actually records it is
// (org, workspace, tool_type, tool_name), which is what :Tool is keyed on.
// Restoring the version grain is tracked separately; until it exists, the
// edge lands where the data can support it.
//
// NO :Skill / :SkillVersion / LOADED_SKILL IS WRITTEN. The same audit found
// no per-execution skill-load record anywhere: ClickHouse `skill_loads` has
// the right shape, and its sole producer
// (packages/agent/src/handlers/agent.skill.load.ts) hardcodes
// `execution_step_id: null` because CapabilityContext carries no execution or
// step id to hand it. Projecting the edge from the `load_skill` rows that do
// land in agent_tool_calls would cover only model-initiated loads on the chat
// path, and absence in the graph would read as "this run loaded no skills"
// rather than "this load was not recorded" — a false negative aimed at
// exactly the question the projection exists to answer. Those rows still
// appear here honestly, as an INVOKED edge to the `load_skill` :Tool.
//
// Callers: the two handlers that terminate an execution
// (packages/handlers/src/agent.execution.record.ts and
// chat.message.execution.ts), best-effort — this function throws on failure
// (Postgres or Neo4j), and it is the CALL SITE's job to catch/log and never
// let a graph failure fail or slow an execution.
//
// Self-contained tenant scope: this function opens its own runInTenantScope()
// so it is directly callable from a future backfill script with nothing but
// {executionId, orgId, workspaceId}.

export interface ProjectExecutionToolUsageArgs {
  /** agent.agent_executions.id (the internal uuid — NOT the public_id). */
  executionId: string;
  orgId: string;
  workspaceId: string;
}

/** One (tool_type, tool_name) this execution invoked, with its call tallies. */
interface ToolUsageRow extends Record<string, unknown> {
  tool_type: string;
  tool_name: string;
  call_count: number;
  failed_call_count: number;
  first_invoked_at: Date;
  last_invoked_at: Date;
}

/**
 * Does this execution exist in the authoritative table? Asked separately from
 * the tool-call aggregation below because the aggregation returns zero rows
 * for two different facts — an execution that invoked no tools, and an
 * execution id that resolves to nothing — and those must not be conflated. An
 * execution that used no tools still gets its :Execution anchor.
 */
async function loadExecutionId(args: {
  executionId: string;
  orgId: string;
  workspaceId: string;
}): Promise<string | null> {
  const { executionId, orgId, workspaceId } = args;
  const rows = await withTenantDb((tx) =>
    tx
      .select({ id: schema.agentExecutions.id })
      .from(schema.agentExecutions)
      .where(
        and(
          eq(schema.agentExecutions.id, executionId),
          eq(schema.agentExecutions.orgId, orgId),
          eq(schema.agentExecutions.workspaceId, workspaceId),
        ),
      ),
  );
  return rows[0]?.id ?? null;
}

/**
 * Every distinct tool this execution invoked, tallied.
 *
 * The join to agent_execution_steps is what supplies execution_id —
 * agent_tool_calls carries only execution_step_id. Both sides are filtered on
 * org + workspace rather than relying on the step join alone, so a mis-scoped
 * step row can never widen the result. ORDER BY makes the projected parameter
 * list deterministic, which is what lets a re-run issue byte-identical
 * statements.
 */
async function loadToolUsage(args: {
  executionId: string;
  orgId: string;
  workspaceId: string;
}): Promise<ToolUsageRow[]> {
  const { executionId, orgId, workspaceId } = args;
  const result = await withTenantDb((tx) =>
    tx.execute<ToolUsageRow>(sql`
      SELECT
        tc.tool_type,
        tc.tool_name,
        count(*)::int AS call_count,
        count(*) FILTER (WHERE tc.status = 'failed')::int AS failed_call_count,
        min(tc.created_at) AS first_invoked_at,
        max(tc.created_at) AS last_invoked_at
      FROM agent.agent_tool_calls tc
      JOIN agent.agent_execution_steps s
        ON s.id = tc.execution_step_id
       AND s.org_id = ${orgId}::uuid
       AND s.workspace_id = ${workspaceId}::uuid
      WHERE s.execution_id = ${executionId}::uuid
        AND tc.org_id = ${orgId}::uuid
        AND tc.workspace_id = ${workspaceId}::uuid
      GROUP BY tc.tool_type, tc.tool_name
      ORDER BY tc.tool_type, tc.tool_name
    `),
  );
  return Array.from(result as unknown as ToolUsageRow[]);
}

const EXECUTION_LABEL = NodeLabels.Execution;
const TOOL_LABEL = NodeLabels.Tool;
const INVOKED = EdgeTypes.INVOKED;

// Three separate, independently-valid MERGE statements rather than one
// chained multi-UNWIND: idempotency is unaffected (each is a plain MERGE on a
// stable key) and each stays trivially reviewable — including the SCOPE_GUARD
// requirement that every statement literally contain the `orgId` token.

// Anchors the execution so the INVOKED edges have a tail even when nothing
// else has recorded this execution in the graph yet. ON CREATE only: the
// citation path (packages/agent/src/memory/neo4j.ts `recordExecution`) owns
// task_summary/started_at/ended_at on this node, and this projection must
// never clobber them. publicId is coalesced the same way that writer does it,
// so whichever of the two creates the node first produces the same shape.
const MERGE_EXECUTION_CYPHER = /* cypher */ `
  MERGE (e:${EXECUTION_LABEL} {id: $executionId, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    e:GraphNode,
    e.is_system = true,
    e.label = '${EXECUTION_LABEL}',
    e.publicId = coalesce(e.publicId, randomUUID()),
    e.started_at = datetime()
`;

const MERGE_TOOLS_CYPHER = /* cypher */ `
  UNWIND $tools AS tl
  MERGE (t:${TOOL_LABEL} {id: tl.id, orgId: $orgId, workspaceId: $workspaceId})
  ON CREATE SET
    t:GraphNode,
    t.is_system = true,
    t.label = '${TOOL_LABEL}',
    t.publicId = tl.publicId,
    t.createdAt = datetime()
  SET
    t.name = tl.name,
    t.toolType = tl.toolType,
    t.displayName = tl.displayName,
    t.updatedAt = datetime()
`;

const MERGE_INVOKED_EDGES_CYPHER = /* cypher */ `
  UNWIND $tools AS tl
  MATCH (e:${EXECUTION_LABEL} {id: $executionId, orgId: $orgId, workspaceId: $workspaceId})
  MATCH (t:${TOOL_LABEL} {id: tl.id, orgId: $orgId, workspaceId: $workspaceId})
  MERGE (e)-[i:${INVOKED}]->(t)
  ON CREATE SET i.is_system = true
  SET
    i.callCount = tl.callCount,
    i.failedCallCount = tl.failedCallCount,
    i.firstInvokedAt = datetime(tl.firstInvokedAt),
    i.lastInvokedAt = datetime(tl.lastInvokedAt),
    i.updatedAt = datetime()
`;

function toIso(d: Date): string {
  return d.toISOString();
}

/**
 * A tool's graph identity. There is no agent.tools row to carry one, so the
 * key is derived from the columns that do identify the tool —
 * (tool_type, tool_name) — and is stable across runs by construction. The
 * publicId additionally carries the tenant scope because the :Tool and
 * :GraphNode publicId constraints are graph-global, so two workspaces using a
 * tool of the same name must not collide on it.
 */
function toolIdentity(row: ToolUsageRow, orgId: string, workspaceId: string) {
  return {
    id: `${row.tool_type}:${row.tool_name}`,
    publicId: `${orgId}:${workspaceId}:${row.tool_type}:${row.tool_name}`,
  };
}

async function writeToolGraph(args: {
  executionId: string;
  orgId: string;
  workspaceId: string;
  usage: ToolUsageRow[];
}): Promise<void> {
  const { executionId, orgId, workspaceId, usage } = args;

  const toolParams = usage.map((row) => ({
    ...toolIdentity(row, orgId, workspaceId),
    name: row.tool_name,
    toolType: row.tool_type,
    callCount: row.call_count,
    failedCallCount: row.failed_call_count,
    firstInvokedAt: toIso(row.first_invoked_at),
    lastInvokedAt: toIso(row.last_invoked_at),
    displayName: `Tool: ${row.tool_name}`,
  }));

  const s = scopedSession();
  try {
    await s.run(MERGE_EXECUTION_CYPHER, { executionId });
    if (toolParams.length > 0) {
      await s.run(MERGE_TOOLS_CYPHER, { tools: toolParams });
      await s.run(MERGE_INVOKED_EDGES_CYPHER, {
        executionId,
        tools: toolParams,
      });
    }
  } finally {
    await s.close();
  }
}

/**
 * Project the tools `executionId` invoked into Neo4j as :Tool nodes joined to
 * the :Execution by :INVOKED edges. Reads the CURRENT authoritative Postgres
 * state — safe to call repeatedly (idempotent MERGE) and for any executionId,
 * including one still running. An execution that invoked no tools still gets
 * its :Execution anchor, so "used no tools" and "never projected" stay
 * distinguishable. No-ops when the execution does not exist (e.g. an id from a
 * torn-down test tenant).
 *
 * Throws on Postgres or Neo4j failure — deliberately NOT swallowed here so a
 * direct/backfill caller sees a real failure signal. The production call sites
 * catch and log instead of propagating, per the "never fail or slow an
 * execution" rule — see the module doc above.
 */
export async function projectExecutionToolUsage(
  args: ProjectExecutionToolUsageArgs,
): Promise<void> {
  const { executionId, orgId, workspaceId } = args;
  await runInTenantScope({ orgId, workspaceId }, async () => {
    const found = await loadExecutionId({ executionId, orgId, workspaceId });
    if (!found) {
      logger.warn(
        { executionId, orgId },
        "projectExecutionToolUsage: execution not found — nothing to project",
      );
      return;
    }
    const usage = await loadToolUsage({ executionId, orgId, workspaceId });
    await writeToolGraph({ executionId, orgId, workspaceId, usage });
  });
}
