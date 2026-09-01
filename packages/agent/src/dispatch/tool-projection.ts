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
// TOOL IDENTITY IS THE SLUG, so this projection and the asset registry
// converge on one node instead of two. agent.tools is keyed
// UNIQUE (workspace_id, slug), and tool.declaration.publish defines that slug
// as `input.name.trim().toLowerCase()` — so `lower(tool_name)` from an
// invocation addresses the declaration exactly. :Tool is MERGEd on that slug
// and takes the declaration's public_id when one exists, so a later registry
// projection MERGEs the same node and enriches it rather than colliding with
// it on the graph-global publicId constraint. A tool invoked but never
// declared still gets a node, with a derived publicId and `declared = false`:
// the registry is populated by publishing, not by running, so keying on the
// declaration alone would drop every undeclared tool from the graph — and
// absence would then read as "this run used no such tool".
//
// NO :ToolVersion NODE IS WRITTEN, and INVOKED therefore points at :Tool.
// packages/ontology/src/schema.cypher records the edge as
// :Execution -> :ToolVersion. agent.tool_versions does exist (the asset
// registry restored it — it had been dropped as dead in
// packages/database/drizzle/migration_archive/0004_drop_dead_tables.sql), but
// the missing link is not the table: agent_tool_calls records tool_name and
// tool_type and no version at all, so nothing says which version a given
// invocation ran. agent.tools.active_version_id names the version pinned
// NOW, and attributing a past invocation to it would date every historical
// edge to today's pin. Until an invocation carries its version, the edge
// lands at the grain the data can support.
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

/** One tool this execution invoked, keyed by slug, with its call tallies. */
interface ToolUsageRow extends Record<string, unknown> {
  slug: string;
  tool_name: string;
  tool_type: string;
  /** agent.tools.public_id when the tool is declared, else null. */
  declared_public_id: string | null;
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
 * step row can never widen the result. The LEFT JOIN to agent.tools attaches
 * the declaration's public_id where the tool is declared and leaves it null
 * where it is not; it cannot multiply rows, because (workspace_id, slug) is
 * unique there.
 *
 * Grouping is by slug alone — the identity — so two spellings of one tool name
 * tally into the single node they address rather than racing each other's
 * counts through it. `name` and `type` are display facts chosen with min() for
 * determinism. ORDER BY makes the projected parameter list deterministic,
 * which is what lets a re-run issue byte-identical statements.
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
        lower(tc.tool_name) AS slug,
        min(tc.tool_name) AS tool_name,
        min(tc.tool_type) AS tool_type,
        max(t.public_id::text) AS declared_public_id,
        count(*)::int AS call_count,
        count(*) FILTER (WHERE tc.status = 'failed')::int AS failed_call_count,
        min(tc.created_at) AS first_invoked_at,
        max(tc.created_at) AS last_invoked_at
      FROM agent.agent_tool_calls tc
      JOIN agent.agent_execution_steps s
        ON s.id = tc.execution_step_id
       AND s.org_id = ${orgId}::uuid
       AND s.workspace_id = ${workspaceId}::uuid
      LEFT JOIN agent.tools t
        ON t.slug = lower(tc.tool_name)
       AND t.org_id = ${orgId}::uuid
       AND t.workspace_id = ${workspaceId}::uuid
       AND t.deleted_at IS NULL
      WHERE s.execution_id = ${executionId}::uuid
        AND tc.org_id = ${orgId}::uuid
        AND tc.workspace_id = ${workspaceId}::uuid
      GROUP BY lower(tc.tool_name)
      ORDER BY lower(tc.tool_name)
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
    t.publicId = CASE WHEN tl.declared THEN tl.publicId ELSE t.publicId END,
    t.slug = tl.id,
    t.name = tl.name,
    t.toolType = tl.toolType,
    t.declared = tl.declared,
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
 * A tool's graph identity: the slug it is addressed by, plus the declaration's
 * public_id when the tool is declared in the asset registry.
 *
 * The derived fallback carries the tenant scope because the :Tool and
 * :GraphNode publicId constraints are graph-global, so two workspaces that
 * invoke an undeclared tool of the same name must not collide on it. It is
 * prefixed `undeclared:` so a reader can tell a derived address from a
 * registry one without joining anything.
 */
function toolIdentity(row: ToolUsageRow, orgId: string, workspaceId: string) {
  return {
    id: row.slug,
    publicId:
      row.declared_public_id ??
      `undeclared:${orgId}:${workspaceId}:${row.slug}`,
    declared: row.declared_public_id !== null,
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
