import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import pino from "pino";
import { agentMcpSetEnabled } from "@oxagen/oxagen/contracts/agent.mcp.set_enabled";
import type { CapabilityContext } from "../types";
import { healthcheck } from "../dispatch/mcp-client";
import {
  captureToolSnapshots,
  recordServerChange,
} from "../runtime/mcp-snapshots";
import { decryptMcpAuthConfig } from "../runtime/mcp-server-auth-crypto";
import type {
  AgentMcpSetEnabledInput,
  AgentMcpSetEnabledOutput,
} from "@oxagen/oxagen/contracts/agent.mcp.set_enabled";

export type { AgentMcpSetEnabledInput, AgentMcpSetEnabledOutput };

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.mcp" },
});

export async function agentMcpSetEnabledHandler(
  input: AgentMcpSetEnabledInput,
  ctx: CapabilityContext,
): Promise<AgentMcpSetEnabledOutput> {
  // Resolve the server by its public id within the tenant scope. Soft-deleted
  // servers cannot be re-enabled (delete is terminal).
  const [server] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.mcpServers.id,
        transportType: schema.mcpServers.transportType,
        endpointUrl: schema.mcpServers.endpointUrl,
        authStrategy: schema.mcpServers.authStrategy,
        authConfig: schema.mcpServers.authConfig,
      })
      .from(schema.mcpServers)
      .where(
        and(
          eq(schema.mcpServers.publicId, input.mcpServerId),
          eq(schema.mcpServers.orgId, ctx.orgId),
          eq(schema.mcpServers.workspaceId, ctx.workspaceId),
          isNull(schema.mcpServers.deletedAt),
        ),
      )
      .limit(1),
  );
  if (!server) throw new Error("mcp server not found");

  // Re-enabling re-probes and re-captures snapshots (descriptors may have
  // changed while disabled). Disabling skips the probe.
  let snapshotCount = 0;
  let healthStatus: "healthy" | "degraded" | "unreachable" = "degraded";
  if (input.enabled && server.transportType === "streamable-http") {
    // Decrypt: server.authConfig is the envelope-encrypted (or
    // legacy plaintext, pre-backfill) jsonb value read from the DB.
    const decryptedAuthConfig = await decryptMcpAuthConfig(server.authConfig);
    const probe = await healthcheck({
      endpointUrl: server.endpointUrl,
      authStrategy: server.authStrategy as "none" | "bearer" | "header",
      authConfig: decryptedAuthConfig,
    });
    healthStatus = probe.status;
    if (probe.descriptors.length > 0) {
      snapshotCount = await captureToolSnapshots({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        mcpServerId: server.id,
        descriptors: probe.descriptors,
        createdByUserId: ctx.userId,
      }).catch((err: unknown) => {
        // A dropped tool-snapshot means the server is being enabled with no
        // recorded baseline — the contract-governance / tool-poisoning-detection
        // wedge silently loses its reference point. Surface it (best-effort:
        // enabling still proceeds with a 0 count).
        logger.warn(
          { err, mcpServerId: server.id },
          "agent.mcp.set_enabled: tool snapshot failed — enabling with no baseline",
        );
        return 0;
      });
    }
  }

  await withTenantDb((tx) =>
    tx
      .update(schema.mcpServers)
      .set({
        enabled: input.enabled,
        ...(input.enabled
          ? { healthStatus, lastHealthcheckAt: new Date() }
          : {}),
        updatedAt: new Date(),
        updatedByUserId: ctx.userId,
      })
      .where(eq(schema.mcpServers.id, server.id)),
  );

  // Audit the lifecycle change.
  await recordServerChange({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    serverId: server.id,
    changeType: input.enabled ? "enable" : "disable",
    actorUserId: ctx.userId,
  });

  return {
    mcpServerId: input.mcpServerId,
    enabled: input.enabled,
    snapshotCount,
  };
}

// The lazy resolver derives the camelCase export name by capitalizing each
// dot-segment; for "agent.mcp.set_enabled" that yields "agentMcpSet_enabledHandler"
// (underscores are not camelized), which does not match the readable export
// above. Provide a default export so resolveHandler() falls through to it. The
// resolver types loaders with `input: unknown`, so the default narrows the raw
// input through the contract schema before delegating to the typed handler.
export default async function agentMcpSetEnabledDefault(
  input: unknown,
  ctx: CapabilityContext,
): Promise<AgentMcpSetEnabledOutput> {
  return agentMcpSetEnabledHandler(agentMcpSetEnabled.input.parse(input), ctx);
}
