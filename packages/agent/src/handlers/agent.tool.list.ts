import pino from "pino";
import type { CapabilityContext } from "../types";
import type {
  AgentToolListInput,
  AgentToolListOutput,
} from "@oxagen/oxagen/contracts/agent.tool.list";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { pluginForContract } from "@oxagen/oxagen/plugins";
import { listEntitledCapabilityPluginIds } from "@oxagen/plugins";
import { getOxagenRegistry } from "../registry-loader";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "list_agent_tools" },
});

export type { AgentToolListInput, AgentToolListOutput };

export async function agentToolListHandler(
  input: AgentToolListInput,
  ctx: CapabilityContext,
): Promise<AgentToolListOutput> {
  const { listCapabilities, getSurfaces } = await getOxagenRegistry();
  // This is the tool-LIST filter only (display/UX layer). The kernel gate is
  // the real security enforcement boundary.
  let entitledPluginIds: Set<string> | null = null;
  let entitlementFetchFailed = false;
  const builtins: AgentToolListOutput["tools"] = [];
  for (const c of listCapabilities()) {
    if (!getSurfaces(c).includes("agent")) continue;

    // Entitlement filter: if this capability is claimed by a plugin, verify the
    // org has that plugin installed and enabled. Lazily fetch the entitled set
    // on first plugin-claimed contract to avoid DB round-trips when no plugin
    // capabilities are present.
    const plugin = pluginForContract(c.name);
    if (plugin) {
      if (!entitlementFetchFailed && entitledPluginIds === null) {
        try {
          entitledPluginIds = await listEntitledCapabilityPluginIds(
            ctx.orgId,
            ctx.workspaceId,
          );
        } catch (err) {
          logger.warn(
            { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
            "entitlement fetch failed — excluding all plugin-claimed capabilities (fail-closed)",
          );
          entitlementFetchFailed = true;
        }
      }
      // Fail-closed: if fetch threw, exclude all plugin-claimed tools.
      if (
        entitlementFetchFailed ||
        (entitledPluginIds !== null && !entitledPluginIds.has(plugin.id))
      )
        continue;
    }
    builtins.push({
      name: c.name,
      description: c.description,
      domain: c.domain ?? "",
      category: c.agent?.category ?? null,
      riskLevel: c.agent?.riskLevel ?? "low",
      requiresApproval: c.agent?.requiresApproval ?? false,
      external: false,
    });
  }

  if (!input.includeExternal) return { tools: builtins };

  // Single tenant-scoped query; no per-server tool fanout. The discoveredTools
  // jsonb column is the cached snapshot from the last health check.
  const servers = await withTenantDb((tx) =>
    tx
      .select({
        name: schema.mcpServers.name,
        discoveredTools: schema.mcpServers.discoveredTools,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  const external = servers.flatMap((s) =>
    (Array.isArray(s.discoveredTools)
      ? (s.discoveredTools as string[])
      : []
    ).map((t) => ({
      name: `${s.name}.${t}`,
      description: `External MCP tool ${t} on ${s.name}`,
      domain: "external",
      category: "external",
      riskLevel: "medium" as const,
      requiresApproval: true,
      external: true,
    })),
  );

  return { tools: [...builtins, ...external] };
}
