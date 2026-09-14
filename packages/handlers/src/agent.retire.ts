// agent.retire.ts — retire an agent identity (MC spec §6.2, App. E; #2956).
// Role gate: org Owner or Admin (INV-29). One transaction archives the
// agent row, suspends the principal, soft-deletes every live credential and
// revokes every live host (its key retired and a `revoke` command queued,
// the same three writes `revoke_tacho_enrollment` makes). Nothing is
// deleted: runs keep the agent's key and principal. Retiring a retired
// agent answers the recorded retirement without a write.
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentKeysFor } from "@oxagen/agent/handlers/_agent-identity";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import {
  requireAgentIdentity,
  revokeAgentCredentials,
} from "./lib/agent-identity";
import { logger } from "./logger";

const REVOKE_COMMAND_TTL_MS = 24 * 60 * 60 * 1000;

export const agentRetireHandler: CapabilityHandler<typeof agentRetire> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    throw new HandlerError({
      code: "forbidden",
      reason: "no_principal",
      message: "retire_agent requires a signed-in user",
    });
  }
  const userId = ctx.userId;
  await assertOrgRole(ctx, { org: [...AGENT_IDENTITY_ROLES] });

  const now = new Date();
  const reason = input.reason ?? "agent retired";
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const agent = await requireAgentIdentity(tx, input.agentId, scope);
    if (agent.status === "archived") {
      return { agent, already: true, credentials: 0, hosts: 0, retiredAt: now };
    }

    await tx
      .update(schema.agents)
      .set({
        status: "archived",
        deploymentStatus: "inactive",
        updatedAt: now,
        updatedByUserId: userId,
      })
      .where(eq(schema.agents.id, agent.id));
    if (agent.principalId) {
      await tx
        .update(schema.principals)
        .set({
          status: "suspended",
          updatedAt: now,
          updatedByUserId: userId,
          metadata: { retired_at: now.toISOString(), retire_reason: reason },
        })
        .where(eq(schema.principals.id, agent.principalId));
    }
    const credentials = await revokeAgentCredentials(tx, {
      ...scope,
      userId,
      agentPublicId: agent.publicId,
      now,
    });

    const agentKey =
      (await agentKeysFor(tx, scope, [agent])).get(agent.id) ?? null;
    let hosts = 0;
    if (agentKey) {
      const live = await tx
        .select({
          id: schema.tachoHosts.id,
          apiKeyId: schema.tachoHosts.apiKeyId,
        })
        .from(schema.tachoHosts)
        .where(
          and(
            eq(schema.tachoHosts.orgId, ctx.orgId),
            eq(schema.tachoHosts.workspaceId, ctx.workspaceId),
            eq(schema.tachoHosts.agentKey, agentKey),
            inArray(schema.tachoHosts.status, [
              "active",
              "paused",
              "suspended",
            ]),
          ),
        );
      for (const host of live) {
        await tx
          .update(schema.tachoHosts)
          .set({
            status: "revoked",
            revokedAt: now,
            revokeReason: reason,
            updatedAt: now,
            updatedByUserId: userId,
          })
          .where(eq(schema.tachoHosts.id, host.id));
        await tx
          .update(schema.apiKeys)
          .set({
            deletedAt: now,
            deletedByUserId: userId,
            updatedAt: now,
            updatedByUserId: userId,
          })
          .where(eq(schema.apiKeys.id, host.apiKeyId));
        await tx.insert(schema.tachoControlCommands).values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          hostId: host.id,
          command: "revoke",
          payload: { reason },
          issuedByUserId: userId,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + REVOKE_COMMAND_TTL_MS),
          createdByUserId: userId,
          updatedByUserId: userId,
        });
      }
      hosts = live.length;
    }
    return {
      agent,
      already: false,
      credentials: credentials.length,
      hosts,
      retiredAt: now,
    };
  });

  if (!result.already) {
    emitSecurityEvent({
      eventType: "agent.retired",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: agentRetire.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    if (result.credentials + result.hosts > 0) {
      emitSecurityEvent({
        eventType: "api_key.revoked",
        actorUserId: userId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        capability: agentRetire.name,
        outcome: "success",
        ip: null,
        userAgent: null,
        requestId: ctx.requestId ?? null,
      });
    }
    logger.info(
      {
        orgId: ctx.orgId,
        agentId: result.agent.publicId,
        credentials: result.credentials,
        hosts: result.hosts,
      },
      "agent.retire: identity retired",
    );
  }

  return {
    agentId: result.agent.publicId,
    status: "retired",
    revokedCredentials: result.credentials,
    revokedHosts: result.hosts,
    retiredAt: result.retiredAt.toISOString(),
  };
};
