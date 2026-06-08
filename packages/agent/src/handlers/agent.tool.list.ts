import type { CapabilityContext } from "../types";
import type { AgentToolListInput, AgentToolListOutput } from "@oxagen/oxagen/contracts/agent.tool.list";
import { withTenantDb, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { getOxagenRegistry } from "../registry-loader";

export type { AgentToolListInput, AgentToolListOutput };

export async function agentToolListHandler(
  input: AgentToolListInput,
  ctx: CapabilityContext,
): Promise<AgentToolListOutput> {
  const { listCapabilities, getSurfaces } = await getOxagenRegistry();
  const builtins = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .map((c) => ({
      name: c.name,
      description: c.description,
      domain: c.domain ?? "",
      category: c.agent?.category ?? null,
      riskLevel: c.agent?.riskLevel ?? "low",
      requiresApproval: c.agent?.requiresApproval ?? false,
      external: false,
    }));

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
    (Array.isArray(s.discoveredTools) ? (s.discoveredTools as string[]) : []).map((t) => ({
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
