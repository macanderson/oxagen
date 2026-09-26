// agent.credential.rotate.ts — replace an agent's long-lived credential
// (MC spec §6.2, #2956). Role gate: org Owner or Admin (INV-29), for the
// signed-in user or the creator of the API key (resolveActingUserId). The old
// keys are soft-deleted and the new one minted in one transaction; a
// retired agent is refused with `conflict`, and the built-in assistant with
// `forbidden`, since a credential for it would act as stella's principal.
import { withTenantDb } from "@oxagen/database";
import { emitSecurityEvent } from "@oxagen/database/security";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentCredentialRotate } from "@oxagen/oxagen/contracts/agent.credential.rotate";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import {
  assertNotManaged,
  assertNotRetired,
  mintAgentCredential,
  requireAgentIdentity,
  revokeAgentCredentials,
} from "./lib/agent-identity";
import { logger } from "./logger";

export const agentCredentialRotateHandler: CapabilityHandler<
  typeof agentCredentialRotate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    { org: [...AGENT_IDENTITY_ROLES] },
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const now = new Date();
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const agent = await requireAgentIdentity(tx, input.agentId, scope);
    assertNotManaged(agent);
    assertNotRetired(agent);
    const revoked = await revokeAgentCredentials(tx, {
      ...scope,
      userId,
      agentPublicId: agent.publicId,
      now,
    });
    const credential = await mintAgentCredential(tx, {
      ...scope,
      userId,
      agent,
      validityDays: input.validityDays,
      now,
    });
    return { agent, revoked, credential };
  });

  for (const eventType of ["api_key.revoked", "api_key.created"] as const) {
    if (eventType === "api_key.revoked" && result.revoked.length === 0)
      continue;
    emitSecurityEvent({
      eventType,
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      capability: agentCredentialRotate.name,
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
      revoked: result.revoked,
    },
    "agent.credential.rotate: credential rotated",
  );

  return {
    agentId: result.agent.publicId,
    revokedCredentialId: result.revoked[0] ?? null,
    credential: {
      id: result.credential.publicId,
      secret: result.credential.secret,
      expiresAt: result.credential.expiresAt.toISOString(),
    },
  };
};
