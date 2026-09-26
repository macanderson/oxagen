// agent.suspend.ts — suspend or resume an agent identity (MC spec §6.2,
// #2956). Role gate: org Owner or Admin (INV-29), for the signed-in user
// or the creator of the API key (resolveActingUserId). The principal's status is
// the one write; a retired agent, or one whose principal row is gone, is
// refused with `conflict`, and a
// suspend of a suspended agent (or a resume of an active one) answers the
// current state and the principal's recorded write instant, without a write.
// The built-in assistant (`qa-chat`) cannot be suspended, because stella acts
// through its principal (#4350). It can still be resumed, so a principal
// suspended before that refusal existed has a way back.
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { agentSuspend } from "@oxagen/oxagen/contracts/agent.suspend";
import { eq } from "drizzle-orm";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import {
  assertNotManaged,
  assertNotRetired,
  requireAgentIdentity,
} from "./lib/agent-identity";
import { logger } from "./logger";

export const agentSuspendHandler: CapabilityHandler<
  typeof agentSuspend
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...AGENT_IDENTITY_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const now = new Date();
  const target = input.suspended ? "suspended" : "active";
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const agent = await requireAgentIdentity(tx, input.agentId, scope);
    if (input.suspended) assertNotManaged(agent);
    assertNotRetired(agent);
    if (!agent.principalId || agent.principalUpdatedAt === null) {
      throw new HandlerError({
        code: "conflict",
        reason: "agent_principal_missing",
        message: `Agent "${agent.slug}" has no delegated principal`,
      });
    }
    if (agent.principalStatus === target) {
      return { agent, changed: false, changedAt: agent.principalUpdatedAt };
    }
    await tx
      .update(schema.principals)
      .set({
        status: target,
        updatedAt: now,
        updatedById: userId,
        ...(input.reason !== undefined
          ? { metadata: { suspend_reason: input.reason } }
          : {}),
      })
      .where(eq(schema.principals.id, agent.principalId));
    return { agent, changed: true, changedAt: now };
  });

  if (result.changed) {
    emitSecurityEvent({
      eventType: input.suspended ? "agent.suspended" : "agent.resumed",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: agentSuspend.name,
      outcome: "success",
      ip: null,
      userAgent: null,
      requestId: ctx.requestId ?? null,
    });
    logger.info(
      { orgId: ctx.orgId, agentId: result.agent.publicId, status: target },
      "agent.suspend: principal status changed",
    );
  }
  return {
    agentId: result.agent.publicId,
    status: target,
    changedAt: result.changedAt.toISOString(),
  };
};
