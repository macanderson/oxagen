import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types.js";

export interface AgentMcpListOutput {
  servers: Array<{
    publicId: string;
    name: string;
    transportType: "streamable-http" | "stdio";
    endpointUrl: string;
    healthStatus: "healthy" | "degraded" | "unreachable";
    lastHealthcheckAt: string | null;
    toolCount: number;
  }>;
}

export async function agentMcpListHandler(
  _input: Record<string, never>,
  ctx: CapabilityContext,
): Promise<AgentMcpListOutput> {
  const rows = await db()
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
        eq(schema.mcpServers.tenantId, ctx.tenantId),
        eq(schema.mcpServers.workspaceId, ctx.workspaceId),
      ),
    );
  return {
    servers: rows.map((r) => ({
      publicId: r.publicId,
      name: r.name,
      transportType: r.transportType as "streamable-http" | "stdio",
      endpointUrl: r.endpointUrl,
      healthStatus: r.healthStatus as "healthy" | "degraded" | "unreachable",
      lastHealthcheckAt: r.lastHealthcheckAt ? r.lastHealthcheckAt.toISOString() : null,
      toolCount: Array.isArray(r.discoveredTools) ? (r.discoveredTools as unknown[]).length : 0,
    })),
  };
}
