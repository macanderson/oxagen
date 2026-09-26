// audit-exempt: availability and the default decide what a toolbelt may show and grant nothing; the security event taxonomy has no tool-state type, and the kernel capability.invoke_* audit covers the write.
//
// tool.state.set.ts — an owner or admin decides which tools are available to
// toolbelts and which start active (ADR-198, #4369). Field semantics are on
// the contract (packages/oxagen/src/contracts/tool.state.set.ts).
//
// Role gate: the contract's roles (INV-29). The target is a list of tools or
// every tool one server contributed; a tool or server the workspace does not
// hold is `not_found`. Only rows whose state changes are written and counted.
import { schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { toolStateSet } from "@oxagen/oxagen/contracts/tool.state.set";
import { eq } from "drizzle-orm";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import {
  readWorkspaceTools,
  resolveServerKey,
  serverKeyOf,
  type WorkspaceTool,
} from "./lib/toolbelts";
import { logger } from "./logger";

export const toolStateSetHandler: CapabilityHandler<
  typeof toolStateSet
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolStateSet),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const now = new Date();
  const updated = await withTenantDb(async (tx) => {
    const { tools, servers } = await readWorkspaceTools(tx, scope);
    let targets: WorkspaceTool[];
    if (input.toolIds !== undefined) {
      const byPublicId = new Map(tools.map((t) => [t.publicId, t]));
      targets = input.toolIds.map((id) => {
        const tool = byPublicId.get(id);
        if (!tool) {
          throw new HandlerError({
            code: "not_found",
            reason: "tool_not_found",
            message: `No tool "${id}" in this workspace`,
          });
        }
        return tool;
      });
    } else {
      const key = resolveServerKey(servers, input.serverId ?? null);
      targets = tools.filter((t) => serverKeyOf(t) === key);
    }

    let count = 0;
    for (const tool of new Set(targets)) {
      const available = input.available ?? tool.available;
      const defaultActive = input.defaultActive ?? tool.defaultActive;
      if (
        available === tool.available &&
        defaultActive === tool.defaultActive
      ) {
        continue;
      }
      await tx
        .update(schema.tools)
        .set({
          enabled: available,
          defaultActive,
          updatedAt: now,
          updatedById: userId,
        })
        .where(eq(schema.tools.id, tool.id));
      count += 1;
    }
    return count;
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      updated,
      available: input.available,
      defaultActive: input.defaultActive,
    },
    "tool.state.set: tool state written",
  );
  return { updated };
};
