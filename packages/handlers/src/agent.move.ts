// agent.move.ts — put an agent on another runtime and keep its identity
// (ADR-192, #4369). Semantics are on the contract
// (packages/oxagen/src/contracts/agent.move.ts).
//
// Role gate: org Owner or Admin (INV-29), the same as every agent identity
// write, for the signed-in user or the creator of the API key.
//
// One transaction locks the agent, checks the new runtime is free for its
// harness, writes the next version (`runtime_changed`) with the new runtime
// and the current toolbelt, and revokes every live host enrollment under the
// agent's key through the writes `revoke_tacho_enrollment` shares
// (lib/tacho-host-revoke.ts). A live host holds the agent key
// (`tacho_hosts_agent_key_uniq`), so the new machine cannot enroll until the
// old one lets it go. The principal, its roles, its credentials and its runs
// do not change.
import { isUniqueViolation, schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { agentKeysFor } from "@oxagen/agent/handlers/_agent-identity";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { agentMove } from "@oxagen/oxagen/contracts/agent.move";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import { assertNotRetired, requireAgentIdentity } from "./lib/agent-identity";
import {
  assertRuntimeHarnessFree,
  requireRuntime,
  runtimeHarnessTakenError,
  runtimeRefOf,
  writeAgentVersion,
} from "./lib/runtimes";
import { revokeHostEnrollment } from "./lib/tacho-host-revoke";
import { logger } from "./logger";

/** The host statuses that still hold the agent key. */
const LIVE_HOST_STATUSES = ["active", "paused", "suspended"] as const;

export const agentMoveHandler: CapabilityHandler<typeof agentMove> = async (
  input,
  ctx,
) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...AGENT_IDENTITY_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const agent = await requireAgentIdentity(tx, input.agentId, scope);
    assertNotRetired(agent);
    const runtime = await requireRuntime(tx, scope, input.runtimeId);
    if (agent.runtimeId === runtime.id) {
      throw new HandlerError({
        code: "conflict",
        reason: "same_runtime",
        message: `Agent "${agent.slug}" already runs on "${runtime.name}".`,
      });
    }
    await assertRuntimeHarnessFree(tx, scope, runtime, agent.harness, agent.id);

    const now = new Date();
    let version: number;
    try {
      version = await writeAgentVersion(tx, {
        agentId: agent.id,
        runtimeId: runtime.id,
        toolbeltId: agent.toolbeltId,
        changeKind: "runtime_changed",
        userId,
        now,
      });
    } catch (err) {
      if (isUniqueViolation(err, "agents_runtime_harness_uniq")) {
        throw runtimeHarnessTakenError(runtime, agent.harness, null);
      }
      throw err;
    }

    const agentKey =
      (await agentKeysFor(tx, scope, [agent])).get(agent.id) ?? null;
    let revoked = 0;
    if (agentKey) {
      const live = await tx
        .select({
          id: schema.tachoHosts.id,
          publicId: schema.tachoHosts.publicId,
          apiKeyId: schema.tachoHosts.apiKeyId,
        })
        .from(schema.tachoHosts)
        .where(
          and(
            eq(schema.tachoHosts.orgId, ctx.orgId),
            eq(schema.tachoHosts.workspaceId, ctx.workspaceId),
            eq(schema.tachoHosts.agentKey, agentKey),
            inArray(schema.tachoHosts.status, [...LIVE_HOST_STATUSES]),
          ),
        );
      for (const host of live) {
        await revokeHostEnrollment(tx, host, {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId,
          reason: `agent moved to runtime ${runtime.slug}`,
          now,
        });
      }
      revoked = live.length;
    }
    return { agent, runtime, version, revoked };
  });

  if (result.revoked > 0) {
    emitSecurityEvent({
      eventType: "api_key.revoked",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: agentMove.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
  }
  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agent.publicId,
      runtimeId: result.runtime.publicId,
      version: result.version,
      revokedHosts: result.revoked,
    },
    "agent.move: agent moved to another runtime",
  );
  return {
    agentId: result.agent.publicId,
    runtime: runtimeRefOf(result.runtime),
    version: result.version,
    revokedHosts: result.revoked,
  };
};
