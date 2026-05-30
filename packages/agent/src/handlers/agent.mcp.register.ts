import { db, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types.js";
import { healthcheck } from "../dispatch/mcp-client.js";

export interface AgentMcpRegisterInput {
  name: string;
  transportType: "streamable-http" | "stdio";
  endpointUrl: string;
  authStrategy: "none" | "bearer" | "header";
  authConfig?: Record<string, string>;
}

export interface AgentMcpRegisterOutput {
  mcpServerId: string;
  healthStatus: "healthy" | "degraded" | "unreachable";
  discoveredTools: string[];
}

export async function agentMcpRegisterHandler(
  input: AgentMcpRegisterInput,
  ctx: CapabilityContext,
): Promise<AgentMcpRegisterOutput> {
  // Run the health check before insert so we persist the live tool list
  // alongside the row — the chat surface lists external tools without a
  // second roundtrip.
  const probe =
    input.transportType === "streamable-http"
      ? await healthcheck({
          endpointUrl: input.endpointUrl,
          authStrategy: input.authStrategy,
          authConfig: input.authConfig,
        })
      : { status: "degraded" as const, discoveredTools: [] };

  const [row] = await db()
    .insert(schema.mcpServers)
    .values({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      name: input.name,
      transportType: input.transportType,
      endpointUrl: input.endpointUrl,
      authStrategy: input.authStrategy,
      authConfig: (input.authConfig ?? {}) as object,
      healthStatus: probe.status,
      lastHealthcheckAt: new Date(),
      discoveredTools: probe.discoveredTools as object,
    })
    .returning({ publicId: schema.mcpServers.publicId });
  if (!row) throw new Error("mcp_servers insert failed");
  return {
    mcpServerId: row.publicId,
    healthStatus: probe.status,
    discoveredTools: probe.discoveredTools,
  };
}
