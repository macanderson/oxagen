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
import { schema, withTenantDb } from "@oxagen/database";
import {
  agentKeysFor,
  resolveAgentIdentity,
} from "@oxagen/agent/handlers/_agent-identity";
import { checkConsent } from "@oxagen/agent/runtime/consent";
import {
  decideMcpToolEffect,
  effectiveMcpScopeForRun,
} from "@oxagen/agent/runtime/mcp-rbac";
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
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

/** The audit correlation id of a belt that no run carries. */
const BELT_READ_RUN_ID = "toolbelt-read";

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
  // run's effective MCP rules and the agent principal's standing consent.
  const mcpScope = effectiveMcpScopeForRun(
    agentRun,
    resolution,
    resolveScope,
    now,
    ctx.clientIp ?? null,
  );
  const servers = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.mcpServers.id,
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        discoveredTools: schema.mcpServers.discoveredTools,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.orgId, scope.orgId),
          eq(schema.mcpServers.workspaceId, scope.workspaceId),
          eq(schema.mcpServers.enabled, true),
          isNull(schema.mcpServers.deletedAt),
        ),
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
