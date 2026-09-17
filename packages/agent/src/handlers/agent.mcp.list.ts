import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import type { z } from "zod";
import type { CapabilityContext } from "../types";
import {
  mcpServerHealthStatus,
  mcpServerTransportType,
  type AgentMcpListInput,
  type AgentMcpListOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.list";

export type { AgentMcpListInput, AgentMcpListOutput };

/**
 * A mcp_servers row holds a value the list contract does not admit. The DB
 * CHECK constraints and the NOT NULL jsonb default keep this from happening
 * on any write path, so reaching it means the row was written outside them.
 */
export class McpServerRowInvalidError extends Error {
  readonly code = "mcp_server_row_invalid";
  constructor(publicId: string, column: string, value: unknown) {
    super(
      `mcp_servers row ${publicId}: ${column} holds ${JSON.stringify(value)}`,
    );
    this.name = "McpServerRowInvalidError";
  }
}

function narrow<T extends [string, ...string[]]>(
  schema: z.ZodEnum<T>,
  publicId: string,
  column: string,
  value: unknown,
): T[number] {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new McpServerRowInvalidError(publicId, column, value);
  }
  return parsed.data;
}

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
    servers: rows.map((r) => {
      if (!Array.isArray(r.discoveredTools)) {
        throw new McpServerRowInvalidError(
          r.publicId,
          "discovered_tools",
          r.discoveredTools,
        );
      }
      return {
        publicId: r.publicId,
        name: r.name,
        transportType: narrow(
          mcpServerTransportType,
          r.publicId,
          "transport_type",
          r.transportType,
        ),
        endpointUrl: r.endpointUrl,
        healthStatus: narrow(
          mcpServerHealthStatus,
          r.publicId,
          "health_status",
          r.healthStatus,
        ),
        lastHealthcheckAt: r.lastHealthcheckAt
          ? r.lastHealthcheckAt.toISOString()
          : null,
        toolCount: r.discoveredTools.length,
      };
    }),
  };
}
