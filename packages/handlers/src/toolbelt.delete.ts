// audit-exempt: a toolbelt narrows what an agent is shown and grants nothing, and the security event taxonomy has no toolbelt type; the kernel capability.invoke_* audit covers the write.
//
// toolbelt.delete.ts — delete a custom toolbelt no live agent carries
// (ADR-192, #4369). The row is soft-deleted, so an agent version that named
// the belt still resolves it by id; its member rows stay with it.
//
// Role gate: the contract's roles (INV-29). The All tools belt is refused
// with `conflict`, reason `all_tools_is_derived`; a belt a live agent carries
// with `conflict`, reason `toolbelt_in_use`, naming how many.
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolbeltDelete } from "@oxagen/oxagen/contracts/toolbelt.delete";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import { requireToolbelt } from "./lib/toolbelts";
import { logger } from "./logger";

export const toolbeltDeleteHandler: CapabilityHandler<
  typeof toolbeltDelete
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolbeltDelete),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  await withTenantDb(async (tx) => {
    const belt = await requireToolbelt(tx, scope, input.toolbeltId);
    if (belt.kind === "all_tools") {
      throw new HandlerError({
        code: "conflict",
        reason: "all_tools_is_derived",
        message: "The All tools belt cannot be deleted.",
      });
    }
    // Lock the belt row: an assign_agent_toolbelt racing this delete either
    // commits first and is counted, or waits and then finds the belt gone.
    await tx
      .select({ id: schema.toolbelts.id })
      .from(schema.toolbelts)
      .where(eq(schema.toolbelts.id, belt.id))
      .for("update");
    const [carriers] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.agents)
      .where(
        and(
          eq(schema.agents.orgId, scope.orgId),
          eq(schema.agents.workspaceId, scope.workspaceId),
          eq(schema.agents.toolbeltId, belt.id),
          isNull(schema.agents.deletedAt),
          ne(schema.agents.status, "archived"),
        ),
      );
    const count = carriers?.count ?? 0;
    if (count > 0) {
      throw new HandlerError({
        code: "conflict",
        reason: "toolbelt_in_use",
        message: `${count} ${count === 1 ? "agent carries" : "agents carry"} this toolbelt. Give ${count === 1 ? "it" : "them"} another belt first.`,
      });
    }
    const now = new Date();
    await tx
      .update(schema.toolbelts)
      .set({ deletedAt: now, deletedById: userId, updatedAt: now })
      .where(eq(schema.toolbelts.id, belt.id));
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      toolbeltId: input.toolbeltId,
    },
    "toolbelt.delete: belt deleted",
  );
  return { toolbeltId: input.toolbeltId, deleted: true as const };
};
