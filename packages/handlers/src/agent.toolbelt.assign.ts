// audit-exempt: a toolbelt narrows what an agent is shown and grants nothing; its roles and grants do not change, and the security event taxonomy has no toolbelt type. The kernel capability.invoke_* audit covers the write.
//
// agent.toolbelt.assign.ts — give an agent another toolbelt and keep its
// identity (ADR-192, #4369). Semantics are on the contract
// (packages/oxagen/src/contracts/agent.toolbelt.assign.ts).
//
// Role gate: org Owner or Admin (INV-29), the same as every agent identity
// write. One transaction writes the next version (`toolbelt_changed`) with the
// agent's current runtime and the new belt, and moves the agent row's belt.
import { withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { agentToolbeltAssign } from "@oxagen/oxagen/contracts/agent.toolbelt.assign";
import { AGENT_IDENTITY_ROLES } from "./agent.register";
import { assertNotRetired, requireAgentIdentity } from "./lib/agent-identity";
import { writeAgentVersion } from "./lib/runtimes";
import {
  ensureAllToolsBelt,
  lockToolbeltForCarrier,
  requireToolbelt,
  toolbeltRefOf,
} from "./lib/toolbelts";
import { logger } from "./logger";

export const agentToolbeltAssignHandler: CapabilityHandler<
  typeof agentToolbeltAssign
> = async (input, ctx) => {
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
    const belt = await requireToolbelt(tx, scope, input.toolbeltId);
    await lockToolbeltForCarrier(tx, belt);
    // A row naming no belt carries the All tools belt, so assigning that
    // belt to it is no change either.
    const current =
      agent.toolbeltId ?? (await ensureAllToolsBelt(tx, scope, userId)).id;
    if (current === belt.id) {
      throw new HandlerError({
        code: "conflict",
        reason: "same_toolbelt",
        message: `Agent "${agent.slug}" already carries "${belt.name}".`,
      });
    }
    const version = await writeAgentVersion(tx, {
      agentId: agent.id,
      runtimeId: agent.runtimeId,
      toolbeltId: belt.id,
      changeKind: "toolbelt_changed",
      userId,
      now: new Date(),
    });
    return { agent, belt, version };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: result.agent.publicId,
      toolbeltId: result.belt.publicId,
      version: result.version,
    },
    "agent.toolbelt.assign: toolbelt assigned",
  );
  return {
    agentId: result.agent.publicId,
    toolbelt: toolbeltRefOf(result.belt),
    version: result.version,
  };
};
