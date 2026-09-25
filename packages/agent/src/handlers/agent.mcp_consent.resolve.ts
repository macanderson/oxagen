// resolve_mcp_consent: a person's answer to a first-use consent request for
// an external MCP tool (ADR-XXX).
//
//   1. Role gate: assertOrgRole with the contract's own defaultRoles, for the
//      signed-in user or the creator of the API key (resolveActingUserId), as
//      resolve_approval does. The kernel's IAM check allows every capability
//      for a non-enterprise org, so the handler checks.
//   2. Read the row inside the caller's org and workspace while it is
//      unexpired and unresolved. No row answers `expired`.
//   3. A row that is not a consent request is refused `conflict` /
//      `not_a_consent_request`. Before ADR-XXX this handler answered any
//      pending row by its uuid, so a model holding the tool could approve a
//      write its own turn had parked.
//   4. A call from the run the row records is refused `forbidden` /
//      `run_cannot_resolve_own_approval`.
//   5. The UPDATE repeats the read's guards and the kind. The acting user is
//      recorded as the resolver and as the subject of the durable consent,
//      and the paused stream is told.

import { withTenantDb, schema } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { HandlerError } from "@oxagen/oxagen";
import { agentMcpConsentResolve } from "@oxagen/oxagen/contracts/agent.mcp_consent.resolve";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import { notifyResolution, raisedByCallingRun } from "../runtime/approval";
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

/** The roles the contract admits, read from its `defaultRoles`. */
const CONSENT_RESOLVER_ROLES = {
  org: allowedRoles(agentMcpConsentResolve.defaultRoles.org),
  workspace: allowedRoles(agentMcpConsentResolve.defaultRoles.workspace),
};

function allowedRoles(grants: Record<string, string | undefined>): string[] {
  return Object.entries(grants)
    .filter(([, effect]) => effect === "allow")
    .map(([role]) => role);
}

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
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    CONSENT_RESOLVER_ROLES,
  );

  const dbResolution: "granted" | "denied" =
    input.decision === "granted" ? "granted" : "denied";
  // The underlying HITL row stores resolution as approved/denied (mirrors the
  // approval surface); map the consent decision onto that vocabulary.
  const approvalResolution =
    input.decision === "granted" ? "approved" : "denied";

  const a = schema.approvalRequests;
  const pending = and(
    eq(a.id, input.approvalId),
    eq(a.orgId, ctx.orgId),
    eq(a.workspaceId, ctx.workspaceId),
    sql`${a.expiresAt} > now()`,
    sql`${a.resolution} IS NULL`,
  );

  // One transaction: read the row, refuse what this capability does not
  // answer, then resolve it under the same guards.
  const updated = await withTenantDb(async (tx) => {
    const [row] = await tx
      .select({ kind: a.kind, runPublicId: a.runPublicId })
      .from(a)
      .where(pending)
      .limit(1);
    if (!row) return null;
    if (row.kind !== "consent") {
      throw new HandlerError({
        code: "conflict",
        reason: "not_a_consent_request",
        message:
          "This approval is not a consent request. Approve or deny it on Fleet.",
      });
    }
    if (await raisedByCallingRun(tx, ctx, row.runPublicId)) {
      throw new HandlerError({
        code: "forbidden",
        reason: "run_cannot_resolve_own_approval",
        message:
          "The run that raised this consent request cannot resolve it. Approve or deny it on Fleet.",
      });
    }
    const [resolved] = await tx
      .update(a)
      .set({
        resolution: approvalResolution,
        resolvedAt: new Date(),
        resolvedByUserId: actingUserId,
        note: null,
      })
      .where(and(pending, eq(a.kind, "consent")))
      .returning({ id: a.id, capabilityName: a.capabilityName });
    return resolved ?? null;
  });

  if (updated === null) {
    // Late approver lost the race (expired or already resolved).
    return { approvalId: input.approvalId, resolution: "expired" };
  }

  const parts = parseSynthetic(updated.capabilityName);

  // Persist the durable grant/denial so subsequent calls run inline. The
  // runtime ALSO records consent when the stream's waitForApproval resolves;
  // recordConsent upserts on the unique key so a double-write is harmless and
  // the explicit grantAllTools wildcard here wins.
  if (parts && actingUserId) {
    await recordConsent({
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: actingUserId,
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
