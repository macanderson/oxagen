// agent.retire.ts — retire an agent identity (MC spec §6.2, App. E; #2956).
// Role gate: org Owner or Admin (INV-29), for the signed-in user
// or the creator of the API key (resolveActingUserId). One transaction archives the
// agent row, suspends the principal, soft-deletes every live credential,
// revokes every live host through the writes `revoke_tacho_enrollment`
// shares (lib/tacho-host-revoke.ts), and revokes every mandate still active
// or drafted against the agent's principal (ADR-106, #3124) — an active
// mandate does not survive retirement, so this list of what retirement
// revokes carries the same member `request_mandate`, `grant_mandate` and
// `update_mandate_limits` now refuse to widen. Nothing is
// deleted: runs keep the agent's key and principal. Retiring a retired
// agent answers the recorded retirement, and revokes only the mandates it
// still holds (#3446).
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentRetire } from "@oxagen/oxagen/contracts/agent.retire";
import { agentKeysFor } from "@oxagen/agent/handlers/_agent-identity";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import {
  requireAgentIdentity,
  revokeAgentCredentials,
  revokeAgentMandates,
} from "./lib/agent-identity";
import { revokeHostEnrollment } from "./lib/tacho-host-revoke";
import { logger } from "./logger";

export const agentRetireHandler: CapabilityHandler<typeof agentRetire> = async (
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

  const reason = input.reason ?? "agent retired";
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const agent = await requireAgentIdentity(tx, input.agentId, scope);
    // Lock the agent row before reading its status. `request_mandate` and
    // `grant_mandate` take the same row `FOR SHARE`, so a grant either
    // commits before the mandate scan below sees it, or waits and then reads
    // the agent as archived and refuses (ADR-106, #3124). The re-read also
    // makes two concurrent retirements answer one write and one `already`.
    // `now` is captured only after this lock succeeds: a `grant_mandate`
    // holding the `FOR SHARE` lock can commit a later `updated_at` while
    // this call waits, and a `now` taken before the wait would then record
    // this retirement, and the mandate revocations it causes, as earlier
    // than the grant they are meant to have superseded.
    const [locked] = await tx
      .select({
        status: schema.agents.status,
        updatedAt: schema.agents.updatedAt,
        validUntil: schema.agents.validUntil,
      })
      .from(schema.agents)
      .where(eq(schema.agents.id, agent.id))
      .for("update");
    const now = new Date();
    if ((locked?.status ?? agent.status) === "archived") {
      // An agent archived before retirement revoked mandates (#3437), or
      // archived by a direct write, can still hold active or draft mandates
      // against its principal. Revoke those here, and leave the agent and
      // principal rows as they are (#3446). A clean retired agent holds none,
      // so a repeat retirement still writes nothing.
      let mandates = 0;
      if (agent.principalId) {
        const revoked = await revokeAgentMandates(tx, {
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          principalId: agent.principalId,
          userId,
          reason,
          now,
        });
        mandates = revoked.length;
      }
      // The retirement below is the last identity write an archived agent
      // takes, so its `updated_at` is the instant recorded then. Reads it
      // from the row just locked, not the pre-lock `agent` snapshot, which
      // can be stale if this call itself waited on the lock.
      return {
        agent,
        already: true,
        credentials: 0,
        hosts: 0,
        mandates,
        retiredAt: locked?.validUntil ?? locked?.updatedAt ?? agent.updatedAt,
      };
    }

    await tx
      .update(schema.agents)
      .set({
        status: "archived",
        deploymentStatus: "inactive",
        validUntil: now,
        updatedAt: now,
        updatedById: userId,
      })
      .where(eq(schema.agents.id, agent.id));
    if (agent.principalId) {
      await tx
        .update(schema.principals)
        .set({
          status: "suspended",
          updatedAt: now,
          updatedById: userId,
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

    let mandates = 0;
    if (agent.principalId) {
      const revoked = await revokeAgentMandates(tx, {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        principalId: agent.principalId,
        userId,
        reason,
        now,
      });
      mandates = revoked.length;
    }

    return {
      agent,
      already: false,
      credentials: credentials.length,
      hosts,
      mandates,
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
        mandates: result.mandates,
      },
      "agent.retire: identity retired",
    );
  }
  // Emitted outside the `already` branch: a repeat retirement of an agent
  // archived with live mandates still revokes them (#3446).
  if (result.mandates > 0) {
    emitSecurityEvent({
      eventType: "mandate.revoked",
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

  return {
    agentId: result.agent.publicId,
    status: "retired",
    revokedCredentials: result.credentials,
    revokedHosts: result.hosts,
    revokedMandates: result.mandates,
    retiredAt: result.retiredAt.toISOString(),
  };
};
