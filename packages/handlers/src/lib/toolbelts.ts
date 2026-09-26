// toolbelts.ts — the one place a toolbelt is resolved (ADR-192): the
// workspace's All tools belt, a belt by public id, and the tools a belt holds.
//
// A toolbelt narrows what an agent is shown and never widens a grant. Its
// members are `agent.tools` rows, the workspace's registry of imported and
// declared tools:
//
// - A tool is *available* when an owner or admin made it available
//   (`agent.tools.enabled`), it is not deleted, and the MCP server it came
//   from is not deleted. An unavailable tool is out of every belt.
// - The All tools belt holds every available tool, each active as its
//   `default_active` says. It stores no member rows.
// - A custom belt holds the tools it has rows for in `tools.toolbelt_tools`,
//   each active as its row says, and only while the tool is available.
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import { schema, type Tx } from "@oxagen/database";
import { HandlerError } from "@oxagen/oxagen";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";

/** The slug the All tools belt takes in every workspace; no clone may use it. */
export const ALL_TOOLS_SLUG = "all-tools";
/** The All tools belt's name. */
const ALL_TOOLS_NAME = "All tools";
/** The group name of the workspace's declared and built-in tools. */
export const DECLARED_TOOLS_GROUP = "Declared tools";

type Scope = { orgId: string; workspaceId: string };

export interface ToolbeltRow {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  kind: "all_tools" | "custom";
  description: string | null;
  clonedFromId: string | null;
  updatedAt: Date;
}

const beltColumns = {
  id: schema.toolbelts.id,
  publicId: schema.toolbelts.publicId,
  name: schema.toolbelts.name,
  slug: schema.toolbelts.slug,
  kind: schema.toolbelts.kind,
  description: schema.toolbelts.description,
  clonedFromId: schema.toolbelts.clonedFromId,
  updatedAt: schema.toolbelts.updatedAt,
} as const;

function toBelt(row: {
  id: string;
  publicId: string;
  name: string;
  slug: string;
  kind: string;
  description: string | null;
  clonedFromId: string | null;
  updatedAt: Date;
}): ToolbeltRow {
  return { ...row, kind: row.kind === "all_tools" ? "all_tools" : "custom" };
}

/** The belt as a contract reference. */
export function toolbeltRefOf(belt: ToolbeltRow): {
  id: string;
  name: string;
  slug: string;
  kind: "all_tools" | "custom";
} {
  return {
    id: belt.publicId,
    name: belt.name,
    slug: belt.slug,
    kind: belt.kind,
  };
}

/**
 * The workspace's All tools belt, created the first time any toolbelt path
 * touches the workspace. The insert is `ON CONFLICT DO NOTHING` against
 * `toolbelts_all_tools_uniq`, so two first calls racing create one row, and
 * the select that follows reads whichever won.
 */
export async function ensureAllToolsBelt(
  tx: Tx,
  scope: Scope,
  userId: string | null,
): Promise<ToolbeltRow> {
  const existing = await readAllToolsBelt(tx, scope);
  if (existing) return existing;
  await tx
    .insert(schema.toolbelts)
    .values({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      name: ALL_TOOLS_NAME,
      slug: ALL_TOOLS_SLUG,
      kind: "all_tools",
      createdById: userId,
      updatedById: userId,
    })
    .onConflictDoNothing();
  const created = await readAllToolsBelt(tx, scope);
  if (!created) {
    // The insert conflicted on something other than the All tools index,
    // and nothing it could have conflicted with is an All tools belt.
    throw new Error("toolbelts: the All tools belt could not be created");
  }
  return created;
}

async function readAllToolsBelt(
  tx: Tx,
  scope: Scope,
): Promise<ToolbeltRow | null> {
  const [row] = await tx
    .select(beltColumns)
    .from(schema.toolbelts)
    .where(
      and(
        eq(schema.toolbelts.orgId, scope.orgId),
        eq(schema.toolbelts.workspaceId, scope.workspaceId),
        eq(schema.toolbelts.kind, "all_tools"),
        isNull(schema.toolbelts.deletedAt),
      ),
    )
    .limit(1);
  return row ? toBelt(row) : null;
}

/** A live belt by public id in the caller's workspace, or `not_found`. */
export async function requireToolbelt(
  tx: Tx,
  scope: Scope,
  publicId: string,
): Promise<ToolbeltRow> {
  const [row] = await tx
    .select(beltColumns)
    .from(schema.toolbelts)
    .where(
      and(
        eq(schema.toolbelts.orgId, scope.orgId),
        eq(schema.toolbelts.workspaceId, scope.workspaceId),
        eq(schema.toolbelts.publicId, publicId),
        isNull(schema.toolbelts.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "toolbelt_not_found",
      message: `No toolbelt "${publicId}" in this workspace`,
    });
  }
  return toBelt(row);
}

/**
 * Share-lock a belt an agent is about to carry. `delete_toolbelt` takes the
 * same row `FOR UPDATE` before it counts carriers, so a delete racing the
 * assignment either commits first, and the re-read here finds the belt gone,
 * or waits and then counts the agent.
 */
export async function lockToolbeltForCarrier(
  tx: Tx,
  belt: Pick<ToolbeltRow, "id" | "publicId">,
): Promise<void> {
  const [locked] = await tx
    .select({ deletedAt: schema.toolbelts.deletedAt })
    .from(schema.toolbelts)
    .where(eq(schema.toolbelts.id, belt.id))
    .for("share");
  if (!locked || locked.deletedAt !== null) {
    throw new HandlerError({
      code: "not_found",
      reason: "toolbelt_not_found",
      message: `No toolbelt "${belt.publicId}" in this workspace`,
    });
  }
}

/** Every live belt in the workspace, the All tools belt first, then by name. */
export async function listToolbelts(
  tx: Tx,
  scope: Scope,
): Promise<ToolbeltRow[]> {
  const rows = await tx
    .select(beltColumns)
    .from(schema.toolbelts)
    .where(
      and(
        eq(schema.toolbelts.orgId, scope.orgId),
        eq(schema.toolbelts.workspaceId, scope.workspaceId),
        isNull(schema.toolbelts.deletedAt),
      ),
    )
    .orderBy(asc(schema.toolbelts.name));
  const belts = rows.map(toBelt);
  return [
    ...belts.filter((b) => b.kind === "all_tools"),
    ...belts.filter((b) => b.kind !== "all_tools"),
  ];
}

/** Belts by internal id, deleted ones included, for the `clonedFrom` reference. */
export async function toolbeltsById(
  tx: Tx,
  scope: Scope,
  ids: readonly string[],
): Promise<Map<string, ToolbeltRow>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await tx
    .select(beltColumns)
    .from(schema.toolbelts)
    .where(
      and(
        eq(schema.toolbelts.orgId, scope.orgId),
        eq(schema.toolbelts.workspaceId, scope.workspaceId),
        inArray(schema.toolbelts.id, unique),
      ),
    );
  return new Map(rows.map((r) => [r.id, toBelt(r)]));
}

/** One workspace tool as a belt reads it. */
export interface WorkspaceTool {
  id: string;
  publicId: string;
  slug: string;
  name: string;
  description: string | null;
  source: string;
  /** An owner or admin made it available to toolbelts. */
  available: boolean;
  defaultActive: boolean;
  /** `mcp.mcp_servers.id`, or null for a declared or built-in tool. */
  mcpServerId: string | null;
}

/** A server group as a belt shows it: the MCP server, or the declared tools. */
export interface ToolServer {
  /** `mcp.mcp_servers.id`, or null for the declared tools. */
  id: string | null;
  /** `mcs_…`, or null for the declared tools. */
  publicId: string | null;
  name: string;
}

/**
 * The workspace's tools and the servers they came from. A deleted tool, and
 * every tool of a deleted server, is left out: the registry keeps those rows
 * for replay (#2958), and no belt can show them.
 */
export async function readWorkspaceTools(
  tx: Tx,
  scope: Scope,
): Promise<{ tools: WorkspaceTool[]; servers: Map<string, ToolServer> }> {
  const serverRows = await tx
    .select({
      id: schema.mcpServers.id,
      publicId: schema.mcpServers.publicId,
      name: schema.mcpServers.name,
    })
    .from(schema.mcpServers)
    .where(
      and(
        eq(schema.mcpServers.orgId, scope.orgId),
        eq(schema.mcpServers.workspaceId, scope.workspaceId),
        isNull(schema.mcpServers.deletedAt),
      ),
    )
    .orderBy(asc(schema.mcpServers.name));
  const servers = new Map<string, ToolServer>(serverRows.map((s) => [s.id, s]));
  const toolRows = await tx
    .select({
      id: schema.tools.id,
      publicId: schema.tools.publicId,
      slug: schema.tools.slug,
      name: schema.tools.name,
      description: schema.tools.description,
      source: schema.tools.source,
      enabled: schema.tools.enabled,
      defaultActive: schema.tools.defaultActive,
      mcpServerId: schema.tools.mcpServerId,
    })
    .from(schema.tools)
    .where(
      and(
        eq(schema.tools.orgId, scope.orgId),
        eq(schema.tools.workspaceId, scope.workspaceId),
        isNull(schema.tools.deletedAt),
      ),
    )
    .orderBy(asc(schema.tools.name));
  const tools = toolRows
    .filter((t) => t.mcpServerId === null || servers.has(t.mcpServerId))
    .map((t) => ({
      id: t.id,
      publicId: t.publicId,
      slug: t.slug,
      name: t.name,
      description: t.description,
      source: t.source,
      available: t.enabled,
      defaultActive: t.defaultActive,
      mcpServerId: t.mcpServerId,
    }));
  return { tools, servers };
}

/** A custom belt's member rows: tool id to whether the belt shows it. */
export async function readBeltMembers(
  tx: Tx,
  beltId: string,
): Promise<Map<string, boolean>> {
  const rows = await tx
    .select({
      toolId: schema.toolbeltTools.toolId,
      active: schema.toolbeltTools.active,
    })
    .from(schema.toolbeltTools)
    .where(eq(schema.toolbeltTools.toolbeltId, beltId));
  return new Map(rows.map((r) => [r.toolId, r.active]));
}

/** One tool as a given belt holds it. */
export interface BeltToolState {
  tool: WorkspaceTool;
  /** The belt holds the tool at all. Always true on the All tools belt. */
  member: boolean;
  /** The belt shows the tool to an agent. Never true for an unavailable tool. */
  active: boolean;
}

/**
 * Every workspace tool as `belt` holds it. This is the whole rule the file
 * header states, and every reader goes through it: `get_toolbelt`,
 * `list_toolbelts` and `get_agent_toolbelt`.
 */
export function beltToolStates(
  belt: Pick<ToolbeltRow, "kind">,
  tools: readonly WorkspaceTool[],
  members: ReadonlyMap<string, boolean>,
): BeltToolState[] {
  return tools.map((tool) => {
    if (belt.kind === "all_tools") {
      return {
        tool,
        member: true,
        active: tool.available && tool.defaultActive,
      };
    }
    const row = members.get(tool.id);
    return {
      tool,
      member: row !== undefined,
      active: row === true && tool.available,
    };
  });
}

/**
 * What an agent's belt decides, as the governed identities the runtime
 * checks a call under (`registryCapabilityId`: `mcp.<server uuid>.<tool>` for
 * an imported MCP tool, the slug for a declared one).
 *
 * - `governed` holds every identity the workspace's registry names. The belt
 *   decides only these; a capability the registry does not name is decided
 *   by roles alone.
 * - `active` holds the ones the belt shows. A governed identity outside it is
 *   out of sight for the agent, rule `not_in_toolbelt`.
 *
 * A belt deleted since the agent took it still resolves by id, because the
 * agent still carries it. An agent that names no belt carries the All tools
 * belt.
 */
export async function agentBeltGovernance(
  tx: Tx,
  scope: Scope,
  agent: { toolbeltId: string | null },
  userId: string | null,
): Promise<{
  belt: ToolbeltRow;
  governed: Set<string>;
  active: Set<string>;
}> {
  const belt =
    agent.toolbeltId === null
      ? await ensureAllToolsBelt(tx, scope, userId)
      : ((await toolbeltsById(tx, scope, [agent.toolbeltId])).get(
          agent.toolbeltId,
        ) ?? (await ensureAllToolsBelt(tx, scope, userId)));
  const { tools } = await readWorkspaceTools(tx, scope);
  const members =
    belt.kind === "all_tools"
      ? new Map<string, boolean>()
      : await readBeltMembers(tx, belt.id);
  const identity = (tool: WorkspaceTool) => registryCapabilityId(tool);
  const governed = new Set(tools.map(identity));
  const active = new Set(
    beltToolStates(belt, tools, members)
      .filter((state) => state.active)
      .map((state) => identity(state.tool)),
  );
  return { belt, governed, active };
}

/** The group key of a tool: its server's internal id, or "" for declared tools. */
export function serverKeyOf(tool: Pick<WorkspaceTool, "mcpServerId">): string {
  return tool.mcpServerId ?? "";
}

/**
 * A server named by public id (`mcs_…`) as its group key, the internal id, and
 * null as the declared tools' empty key. An id that names no live server in
 * the workspace is `not_found`, reason `tool_server_not_found`.
 */
export function resolveServerKey(
  servers: ReadonlyMap<string, ToolServer>,
  publicId: string | null,
): string {
  if (publicId === null) return "";
  for (const server of servers.values()) {
    if (server.publicId === publicId && server.id !== null) return server.id;
  }
  throw new HandlerError({
    code: "not_found",
    reason: "tool_server_not_found",
    message: `No MCP server "${publicId}" in this workspace`,
  });
}

/**
 * The imported MCP tools a belt leaves out, as tool-RBAC patterns
 * (`server:tool`, the shape `mcpRuleToHarnessRule` compiles to
 * `mcp__server__tool`). The host bundle denies each one, so a wrapped harness
 * cannot call a workspace tool its agent's belt does not show.
 *
 * Only tools the workspace imported are named. A server the operator
 * configured on the machine and never imported is not the workspace's to
 * narrow, and a declared tool is not an MCP tool the harness calls by that
 * name. Sorted and unique, so the bundle's etag holds still across polls.
 */
export function beltDenyPatterns(
  states: readonly BeltToolState[],
  servers: ReadonlyMap<string, ToolServer>,
): string[] {
  const patterns = new Set<string>();
  for (const { tool, active } of states) {
    if (active || tool.mcpServerId === null || tool.source !== "mcp") continue;
    const server = servers.get(tool.mcpServerId);
    if (server === undefined) continue;
    patterns.add(`${server.name}:${tool.name}`);
  }
  return [...patterns].sort();
}

/**
 * `beltDenyPatterns` for the belt an agent carries, read without writing: an
 * agent that names no belt, or names one that no longer resolves, carries the
 * All tools belt, and that belt's members are derived, so no row has to exist
 * for the answer. The host bundle calls this on every poll, inside the poll's
 * own transaction.
 */
export async function agentBeltDenyPatterns(
  tx: Tx,
  scope: Scope,
  agentId: string,
): Promise<string[]> {
  const [agent] = await tx
    .select({ toolbeltId: schema.agents.toolbeltId })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.id, agentId),
        eq(schema.agents.orgId, scope.orgId),
        eq(schema.agents.workspaceId, scope.workspaceId),
      ),
    )
    .limit(1);
  if (agent === undefined) return [];
  const carried =
    agent.toolbeltId === null
      ? undefined
      : (await toolbeltsById(tx, scope, [agent.toolbeltId])).get(
          agent.toolbeltId,
        );
  const belt: Pick<ToolbeltRow, "kind"> = carried ?? { kind: "all_tools" };
  const { tools, servers } = await readWorkspaceTools(tx, scope);
  const members =
    carried === undefined || carried.kind === "all_tools"
      ? new Map<string, boolean>()
      : await readBeltMembers(tx, carried.id);
  return beltDenyPatterns(beltToolStates(belt, tools, members), servers);
}
