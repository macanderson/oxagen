import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentMcpListInput,
  AgentMcpListOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.list";

export type { AgentMcpListInput, AgentMcpListOutput };

export async function agentMcpListHandler(
  _input: AgentMcpListInput,
  ctx: CapabilityContext,
): Promise<AgentMcpListOutput> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.mcpServers.publicId,
        name: schema.mcpServers.name,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        healthStatus: schema.mcpServers.healthStatus,
        lastHealthcheckAt: schema.mcpServers.lastHealthcheckAt,
        discoveredTools: schema.mcpServers.discoveredTools,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          // Hide soft-deleted servers from the live list.
          isNull(schema.mcpServers.deletedAt),
        ),
      ),
  );
  return {
    servers: rows.map((r) => ({
      publicId: r.publicId,
      name: r.name,
      transportType: r.transportType as "streamable-http" | "stdio",
      endpointUrl: r.endpointUrl,
      healthStatus: r.healthStatus as "healthy" | "degraded" | "unreachable",
      lastHealthcheckAt: r.lastHealthcheckAt
        ? r.lastHealthcheckAt.toISOString()
        : null,
      toolCount: Array.isArray(r.discoveredTools)
        ? (r.discoveredTools as unknown[]).length
        : 0,
    })),
  };
}
