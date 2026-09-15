// agent.retire.ts — retire an agent identity (MC spec §6.2, App. E; #2956).
// Role gate: org Owner or Admin (INV-29). One transaction archives the
// agent row, suspends the principal, soft-deletes every live credential and
// revokes every live host through the writes `revoke_tacho_enrollment`
// shares (lib/tacho-host-revoke.ts). Nothing is
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
import { revokeHostEnrollment } from "./lib/tacho-host-revoke";
import { logger } from "./logger";

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
      // The retirement below is the last identity write an archived agent
      // takes, so its `updated_at` is the instant recorded then.
      return {
        agent,
        already: true,
        credentials: 0,
        hosts: 0,
        retiredAt: agent.updatedAt,
      };
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
          publicId: schema.tachoHosts.publicId,
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
        await revokeHostEnrollment(tx, host, {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          userId,
          reason,
          now,
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
