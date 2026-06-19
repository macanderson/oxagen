import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import { healthcheck, type McpToolDescriptor } from "../dispatch/mcp-client";
import { captureToolSnapshots } from "../runtime/mcp-snapshots";
import type { AgentMcpRegisterInput, AgentMcpRegisterOutput } from "@oxagen/oxagen/contracts/agent.mcp.register";

export type { AgentMcpRegisterInput, AgentMcpRegisterOutput };

export async function agentMcpRegisterHandler(
  input: AgentMcpRegisterInput,
  ctx: CapabilityContext,
): Promise<AgentMcpRegisterOutput> {
  // Run the health check before insert so we persist the live tool list
  // alongside the row — the chat surface lists external tools without a
  // second roundtrip. The probe also returns full per-tool JSONSchema
  // descriptors so we can snapshot them for replay durability (OXA-820).
  const probe: {
    status: "healthy" | "degraded" | "unreachable";
    discoveredTools: string[];
    descriptors: McpToolDescriptor[];
  } =
    input.transportType === "streamable-http"
      ? await healthcheck({
          endpointUrl: input.endpointUrl,
          authStrategy: input.authStrategy,
          authConfig: input.authConfig,
        })
      : { status: "degraded", discoveredTools: [], descriptors: [] };

  const [row] = await withTenantDb((tx) =>
    tx
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
        createdByUserId: ctx.userId,
      })
      .returning({ id: schema.mcpServers.id, publicId: schema.mcpServers.publicId }),
  );
  if (!row) throw new Error("mcp_servers insert failed");

  // Snapshot each discovered tool descriptor (OXA-820). Failure-isolated: a
  // snapshot write must never fail registration of an otherwise-healthy server.
  if (probe.descriptors.length > 0) {
    await captureToolSnapshots({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      mcpServerId: row.id,
      descriptors: probe.descriptors,
      createdByUserId: ctx.userId,
    }).catch(() => {
      /* swallow — server is registered; snapshots can be re-captured on re-enable */
    });
  }

  return {
    mcpServerId: row.publicId,
    healthStatus: probe.status,
    discoveredTools: probe.discoveredTools,
  };
}
