import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution } from "../runtime/approval";
import {
  recordConsent,
  DEFAULT_CONSENT_TTL_MS,
  CONSENT_WILDCARD,
} from "../runtime/consent";
import type {
  AgentMcpConsentResolveInput,
  AgentMcpConsentResolveOutput,
} from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";

export type { AgentMcpConsentResolveInput, AgentMcpConsentResolveOutput };

// Parse `mcp.<serverId>.<tool>` (serverId is a dot-free UUID; the tool name may
// contain dots, so split on the first dot only after the `mcp.` prefix).
function parseSynthetic(
  cap: string,
): { serverId: string; toolName: string } | null {
  if (!cap.startsWith("mcp.")) return null;
  const rest = cap.slice("mcp.".length);
  const dot = rest.indexOf(".");
  if (dot <= 0) return null;
  return { serverId: rest.slice(0, dot), toolName: rest.slice(dot + 1) };
}

export async function agentMcpConsentResolveHandler(
  input: AgentMcpConsentResolveInput,
  ctx: CapabilityContext,
): Promise<AgentMcpConsentResolveOutput> {
  const dbResolution: "granted" | "denied" =
    input.decision === "granted" ? "granted" : "denied";
  // The underlying HITL row stores resolution as approved/denied (mirrors the
  // approval surface); map the consent decision onto that vocabulary.
  const approvalResolution =
    input.decision === "granted" ? "approved" : "denied";

  // Resolve the underlying approval row atomically; reject expired / already-resolved.
  const updated = await withTenantDb((tx) =>
    tx
      .update(schema.approvalRequests)
      .set({
        resolution: approvalResolution,
        resolvedAt: new Date(),
        resolvedByUserId: ctx.userId,
        note: null,
      })
      .where(
        and(
          eq(schema.approvalRequests.id, input.approvalId),
          eq(schema.approvalRequests.orgId, ctx.orgId),
          eq(schema.approvalRequests.workspaceId, ctx.workspaceId),
          sql`${schema.approvalRequests.expiresAt} > now()`,
          sql`${schema.approvalRequests.resolution} IS NULL`,
        ),
      )
      .returning({
        id: schema.approvalRequests.id,
        capabilityName: schema.approvalRequests.capabilityName,
      }),
  );

  if (updated.length === 0) {
    // Late approver lost the race (expired or already resolved).
    return { approvalId: input.approvalId, resolution: "expired" };
  }

  const row = updated[0]!;
  const parts = parseSynthetic(row.capabilityName);

  // Persist the durable grant/denial so subsequent calls run inline. The
  // runtime ALSO records consent when the stream's waitForApproval resolves;
  // recordConsent upserts on the unique key so a double-write is harmless and
  // the explicit grantAllTools wildcard here wins.
  if (parts && ctx.userId) {
    await recordConsent({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      serverId: parts.serverId,
      toolName:
        input.grantAllTools && dbResolution === "granted"
          ? CONSENT_WILDCARD
          : parts.toolName,
      status: dbResolution,
      // Wildcard pre-grants never expire; per-tool grants use the default TTL.
      ttlMs:
        input.grantAllTools && dbResolution === "granted"
          ? null
          : DEFAULT_CONSENT_TTL_MS,
    });
  }

  // Unblock the paused runtime (waitForApproval listens on the same channel).
  await notifyResolution({
    approvalId: input.approvalId,
    resolution: approvalResolution,
    note: null,
  });

  return { approvalId: input.approvalId, resolution: dbResolution };
}
