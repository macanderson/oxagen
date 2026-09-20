// audit-exempt: read-only — computes the belt an agent would be shown and executes nothing; the kernel capability.invoke_* audit covers access.
//
// get_agent_toolbelt — the belt as the runtime would build it, decided by the
// runtime's own per-tool function (packages/agent/src/runtime/toolbelt.ts)
// over the same inputs it uses: the registry, the agent ∩ human resolution
// the kernel memoizes per run, the org's plugin entitlements, the run's MCP
// rules and the agent-subject consent ledger, plus the active emergency
// denies the kernel enforces at invoke time. The caller is the initiating
// human of the delegation ceiling: the belt is the one a run they start would
// carry. Field semantics are on the contract
// (packages/oxagen/src/contracts/agent.toolbelt.get.ts).
//
// Each entry also carries the input schema the model is handed for that tool.
// A capability's comes from the contract in hand, through the runtime's own
// conversion. An MCP tool's comes from the registry version `import_tools`
// published, because a server's cached `tools/list` snapshot holds names and
// no schemas; a server whose tools were never imported reports none rather
// than a placeholder.
import {
  agentKeysFor,
  resolveAgentIdentity,
} from "@oxagen/agent/handlers/_agent-identity";
import { checkConsent } from "@oxagen/agent/runtime/consent";
import {
  decideMcpToolEffect,
  effectiveMcpScopeForRun,
} from "@oxagen/agent/runtime/mcp-rbac";
import { inputJsonSchema } from "@oxagen/agent/runtime/engine/tools";
import { selectMaterializableMcpServers } from "@oxagen/agent/runtime/mcp-servers";
import {
  decideCapabilityForBelt,
  decideMcpToolForBelt,
  type BeltDecision,
} from "@oxagen/agent/runtime/toolbelt";
import {
  fetchAgentRunAuthz,
  readActiveEmergencyDenies,
  readDenyGenerationVector,
  resolveAgentRunAuthzContext,
} from "@oxagen/iam";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { getSurfaces, HandlerError, listCapabilities } from "@oxagen/oxagen";
import {
  agentToolbeltGet,
  BELT_SCHEMA_BYTE_LIMIT,
  FULL_BELT_LIMIT,
  type BeltExclusion,
  type BeltTool,
} from "@oxagen/oxagen/contracts/agent.toolbelt.get";
import {
  createAgentRunResolution,
  type AgentRunIAMContext,
} from "@oxagen/oxagen/iam";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { registryCapabilityId } from "@oxagen/agent/runtime/tool-registry-facts";
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { canonicalJson, sha256Hex } from "./registry-digest";
import { logger } from "./logger";

/** The audit correlation id of a belt that no run carries. */
const BELT_READ_RUN_ID = "toolbelt-read";

/**
 * The schema half of a belt entry: the JSON Schema the model is handed for
 * that tool, where it came from, and the digest that identifies it.
 */
type BeltSchemaFacts = Pick<
  BeltTool,
  "inputSchema" | "schemaOrigin" | "schemaDigest" | "schemaTruncated"
>;

/** What a tool with no recorded schema carries: the NotRecorded state, never a guess. */
const NO_SCHEMA: BeltSchemaFacts = {
  inputSchema: null,
  schemaOrigin: null,
  schemaDigest: null,
  schemaTruncated: false,
};

/**
 * One JSON Schema object as a belt entry carries it.
 *
 * The digest is SHA-256 over the canonical (sorted-key) schema JSON, computed
 * the same way for both sources so two tools with the same input schema carry
 * the same digest. It is not the registry version's manifest checksum, which
 * covers the whole manifest; `list_tool_versions` is where that one is read.
 *
 * A schema over {@link BELT_SCHEMA_BYTE_LIMIT} travels as its digest alone,
 * flagged `schemaTruncated`, rather than making one belt read unbounded.
 */
export function beltSchemaFacts(
  value: unknown,
  origin: "declared" | "imported",
  context: { tool: string },
): BeltSchemaFacts {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return NO_SCHEMA;
  }
  let canonical: string;
  try {
    canonical = canonicalJson(value);
  } catch (err) {
    // A stored schema with no canonical JSON form is a broken row, not a
    // reason to fail the belt read: the entry reports no schema.
    logger.warn(
      { err, tool: context.tool },
      "agent.toolbelt.get: input schema has no canonical form; the entry reports none",
    );
    return NO_SCHEMA;
  }
  const truncated =
    Buffer.byteLength(canonical, "utf8") > BELT_SCHEMA_BYTE_LIMIT;
  return {
    inputSchema: truncated ? null : (value as Record<string, unknown>),
    schemaOrigin: origin,
    schemaDigest: sha256Hex(canonical),
    schemaTruncated: truncated,
  };
}

/**
 * A capability's input schema, derived from the contract in hand through the
 * same conversion the runtime uses to advertise a tool
 * (`packages/agent/src/runtime/engine/tools.ts`), so the belt shows the schema
 * the model actually receives rather than a second rendering of it.
 *
 * Contracts are immutable for the life of the process, so the conversion is
 * memoised per contract object: a belt read covers the whole agent surface.
 */
const capabilitySchemaCache = new WeakMap<object, BeltSchemaFacts>();

async function capabilitySchemaFacts(cap: {
  name: string;
  input: unknown;
}): Promise<BeltSchemaFacts> {
  const cached = capabilitySchemaCache.get(cap);
  if (cached !== undefined) return cached;
  let json: unknown = null;
  try {
    json = await inputJsonSchema(cap.input);
  } catch (err) {
    logger.warn(
      { err, tool: cap.name },
      "agent.toolbelt.get: contract input did not convert to JSON Schema",
    );
  }
  const facts = beltSchemaFacts(json, "declared", { tool: cap.name });
  capabilitySchemaCache.set(cap, facts);
  return facts;
}

/**
 * The input schemas of the workspace's imported MCP tool versions, keyed by
 * the capability id their calls are governed under
 * (`mcp.<server id>.<tool name>`, `registryCapabilityId`).
 *
 * An MCP server's cached `tools/list` snapshot is a list of names only
 * (`mcp.mcp_servers.discovered_tools`), so the schema can only come from the
 * registry row `import_tools` published. A server whose tools were never
 * imported contributes no schema, and those entries report none.
 */
export async function readImportedToolSchemas(
  db: Pick<Tx, "select">,
  scope: { orgId: string; workspaceId: string },
  serverIds: readonly string[],
): Promise<Map<string, BeltSchemaFacts>> {
  const byCapability = new Map<string, BeltSchemaFacts>();
  if (serverIds.length === 0) return byCapability;
  const rows = await db
    .select({
      name: schema.tools.name,
      slug: schema.tools.slug,
      source: schema.tools.source,
      mcpServerId: schema.tools.mcpServerId,
      inputSchema: schema.toolVersions.inputSchema,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.id, schema.tools.activeVersionId),
    )
    .where(
      and(
        eq(schema.tools.orgId, scope.orgId),
        eq(schema.tools.workspaceId, scope.workspaceId),
        isNull(schema.tools.deletedAt),
        eq(schema.tools.source, "mcp"),
        inArray(schema.tools.mcpServerId, [...serverIds]),
      ),
    );
  for (const row of rows) {
    const capabilityId = registryCapabilityId(row);
    byCapability.set(
      capabilityId,
      beltSchemaFacts(row.inputSchema, "imported", { tool: capabilityId }),
    );
  }
  return byCapability;
}

export const agentToolbeltGetHandler: CapabilityHandler<
  typeof agentToolbeltGet
> = async (input, ctx) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const now = new Date();

  const identity = await withTenantDb(async (tx) => {
    const row = await resolveAgentIdentity(tx, input.agentId, scope);
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent "${input.agentId}" in this workspace`,
      });
    }
    const agentKey = (await agentKeysFor(tx, scope, [row])).get(row.id) ?? null;
    return { row, agentKey };
  });
  if (!identity.row.principalId) {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_principal_missing",
      message: `Agent "${identity.row.slug}" has no delegated principal`,
    });
  }

  const all = listCapabilities();
  const agentSurface = all.filter((cap) => getSurfaces(cap).includes("agent"));

  // A suspended or retired principal anchors no run: the runtime refuses to
  // build a context for it (packages/iam/src/agent-run-context.ts), so its
  // belt is empty and every tool is out of sight for that one reason.
  const authz = await resolveAgentRunAuthzContext({
    ...scope,
    agentId: identity.row.publicId,
    initiatingUserId: ctx.userId ?? null,
  });
  const denyGeneration = await withTenantDb((tx) =>
    readDenyGenerationVector(tx, {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
    }),
  );
  const presentation = (beltSize: number) => {
    const mode =
      input.mode ?? (beltSize <= FULL_BELT_LIMIT ? "full" : "searchable");
    return {
      mode,
      limit: FULL_BELT_LIMIT,
      sentToModel:
        mode === "full" ? ("definitions" as const) : ("meta_tools" as const),
    };
  };
  const base = {
    agentId: identity.row.publicId,
    agentKey: identity.agentKey,
    computedAt: now.toISOString(),
  };
  if (authz === null) {
    return {
      ...base,
      basis: {
        humanCeiling: "sentinel" as const,
        roleGrants: 0,
        denyGeneration,
        killSwitches: 0,
      },
      presentation: presentation(0),
      tools: [],
      cannotSee: agentSurface.map((cap) => ({
        name: cap.name,
        kind: "capability" as const,
        server: null,
        rule: "principal_suspended",
      })),
    };
  }

  const snapshot = await fetchAgentRunAuthz({
    ...scope,
    agentPrincipalId: authz.agentPrincipal.id,
    humanPrincipalId: authz.humanPrincipal?.id ?? null,
    now,
  });
  const resolution = createAgentRunResolution(snapshot);
  const agentRun: AgentRunIAMContext = {
    principalKind: "agent",
    agentPrincipal: authz.agentPrincipal,
    humanPrincipal: authz.humanPrincipal,
    agentId: identity.row.publicId,
    runId: BELT_READ_RUN_ID,
    resolution,
  };
  const resolveScope = {
    kind: "workspace" as const,
    orgId: scope.orgId,
    workspaceId: scope.workspaceId,
  };
  const emergencyDenies = await withTenantDb((tx) =>
    readActiveEmergencyDenies(tx, {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
    }),
  );

  // Entitlements are read once, only when a plugin-claimed contract is on the
  // agent surface; a failed read excludes every plugin-claimed tool (fail
  // closed), the same rule the runtime applies.
  let entitled: ReadonlySet<string> | "unavailable" = new Set<string>();
  if (agentSurface.some((cap) => pluginForContract(cap.name))) {
    try {
      entitled = await listEntitledCapabilityPluginIds(
        scope.orgId,
        scope.workspaceId,
      );
    } catch (err) {
      logger.warn(
        { err, orgId: scope.orgId, workspaceId: scope.workspaceId },
        "agent.toolbelt.get: entitlement read failed; plugin-claimed tools are out of the belt",
      );
      entitled = "unavailable";
    }
  }

  const tools: BeltTool[] = [];
  const cannotSee: BeltExclusion[] = [];
  const place = (
    tool: Omit<BeltTool, "decision" | "rule" | "riskLevel" | "readOnly">,
    decision: BeltDecision,
  ) => {
    if (decision.outcome === "deny") {
      cannotSee.push({
        name: tool.name,
        kind: tool.kind,
        server: tool.server,
        rule: decision.rule,
      });
      return;
    }
    tools.push({
      ...tool,
      decision: decision.outcome,
      rule: decision.rule,
      riskLevel: decision.riskLevel,
      readOnly: decision.readOnly,
    });
  };

  for (const cap of agentSurface) {
    place(
      {
        name: cap.name,
        kind: "capability",
        server: null,
        category: cap.agent?.category ?? null,
        ...(await capabilitySchemaFacts(cap)),
      },
      decideCapabilityForBelt(cap, {
        surfaces: getSurfaces(cap),
        agentRun,
        resolution,
        scope: resolveScope,
        now,
        clientIp: ctx.clientIp ?? null,
        emergencyDenies,
        entitledPluginIds: entitled,
      }),
    );
  }

  // MCP tools from the servers' cached `tools/list` snapshot, decided by the
  // run's effective MCP rules and the agent principal's standing consent. The
  // servers are the ones the runtime contributor loads, selected by the same
  // query.
  const mcpScope = effectiveMcpScopeForRun(
    agentRun,
    resolution,
    resolveScope,
    now,
    ctx.clientIp ?? null,
  );
  const servers = await withTenantDb((tx) =>
    selectMaterializableMcpServers(tx, scope),
  );
  const importedSchemas = await withTenantDb((tx) =>
    readImportedToolSchemas(
      tx,
      scope,
      servers.map((server) => server.id),
    ),
  );
  for (const server of servers) {
    const discovered = Array.isArray(server.discoveredTools)
      ? (server.discoveredTools as unknown[]).filter(
          (t): t is string => typeof t === "string",
        )
      : [];
    for (const toolName of discovered) {
      const consent = await checkConsent(
        ctx,
        authz.agentPrincipal.id,
        server.id,
        toolName,
        "agent",
      );
      place(
        {
          name: `${server.name}__${toolName}`,
          kind: "mcp",
          server: server.publicId,
          category: "external",
          ...(importedSchemas.get(
            registryCapabilityId({
              source: "mcp",
              slug: "",
              name: toolName,
              mcpServerId: server.id,
            }),
          ) ?? NO_SCHEMA),
        },
        decideMcpToolForBelt(server.name, toolName, {
          mcpScope,
          consent:
            consent === null
              ? null
              : { status: consent.status === "granted" ? "granted" : "denied" },
          decide: (s, t) => decideMcpToolEffect(mcpScope, s, t),
        }),
      );
    }
  }

  return {
    ...base,
    basis: {
      humanCeiling: authz.humanPrincipal
        ? ("caller" as const)
        : ("sentinel" as const),
      roleGrants: snapshot.roleGrants.length,
      denyGeneration,
      killSwitches: emergencyDenies.length,
    },
    presentation: presentation(tools.length),
    tools,
    cannotSee,
  };
};
