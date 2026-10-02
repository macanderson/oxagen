// `set_agent_cache_keep_alive` (lane F32): turn the model proxy's cache
// keep-alive on or off for one agent in the active workspace. Semantics are on
// the contract (packages/oxagen/src/contracts/agent.cache_keep_alive.set.ts).
//
// Role gate: org Owner or Admin (INV-29), the same as every agent identity
// write. The write needs a real workspace scope, since `agent.agents` is a
// standard table, so the org-only sentinel is refused before any row is read.
// Governed by the kernel's capability.invoke_* audit; no domain event type
// fits a settings toggle.
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  HandlerError,
  ORG_ONLY_WORKSPACE_ID,
  type CapabilityHandler,
} from "@oxagen/oxagen";
import type { agentCacheKeepAliveSet } from "@oxagen/oxagen/contracts/agent.cache_keep_alive.set";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { AGENT_IDENTITY_ROLES } from "./agent.register";

export const agentCacheKeepAliveSetHandler: CapabilityHandler<
  typeof agentCacheKeepAliveSet
> = async (input, ctx) => {
  const userId = await resolveActingUserId(ctx);
  await assertOrgRole({ ...ctx, userId }, { org: [...AGENT_IDENTITY_ROLES] });
  // Under the org-only sentinel there is no workspace to find the agent in.
  if (ctx.workspaceId === ORG_ONLY_WORKSPACE_ID) {
    throw new HandlerError({
      code: "not_found",
      reason: "workspace_required",
      message: "An agent's cache keep-alive is set from inside its workspace",
    });
  }
  const now = new Date();
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .update(schema.agents)
      .set({
        cacheKeepAlive: input.cacheKeepAlive,
        updatedAt: now,
        updatedById: userId,
      })
      .where(
        and(
          eq(schema.agents.orgId, ctx.orgId),
          eq(schema.agents.workspaceId, ctx.workspaceId),
          eq(schema.agents.slug, input.agent),
          isNull(schema.agents.deletedAt),
        ),
      )
      .returning({ id: schema.agents.publicId });
    if (!row) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `No agent ${input.agent} is in this workspace`,
      });
    }
    return { agentId: row.id, cacheKeepAlive: input.cacheKeepAlive };
  });
};
