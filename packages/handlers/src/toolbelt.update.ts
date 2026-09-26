// audit-exempt: a toolbelt narrows what an agent is shown and grants nothing, and the security event taxonomy has no toolbelt type; the kernel capability.invoke_* audit covers the write.
//
// toolbelt.update.ts — rename a custom toolbelt and edit its tools (ADR-198,
// #4369). The change semantics are on the contract
// (packages/oxagen/src/contracts/toolbelt.update.ts); every change applies in
// order, in one transaction, and each sees the ones before it.
//
// Role gate: the contract's roles (INV-29). The All tools belt is derived from
// the workspace's tool settings and refuses every edit with `conflict`,
// reason `all_tools_is_derived`.
import { schema, withTenantDb, type Tx } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  toolbeltUpdate,
  type ToolbeltChange,
} from "@oxagen/oxagen/contracts/toolbelt.update";
import { and, eq, inArray } from "drizzle-orm";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import {
  readBeltMembers,
  readWorkspaceTools,
  requireToolbelt,
  resolveServerKey,
  serverKeyOf,
  toolbeltRefOf,
  type ToolServer,
  type WorkspaceTool,
} from "./lib/toolbelts";
import { logger } from "./logger";

export const toolbeltUpdateHandler: CapabilityHandler<
  typeof toolbeltUpdate
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolbeltUpdate),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const now = new Date();
  const belt = await withTenantDb(async (tx) => {
    const found = await requireToolbelt(tx, scope, input.toolbeltId);
    if (found.kind === "all_tools") {
      throw new HandlerError({
        code: "conflict",
        reason: "all_tools_is_derived",
        message:
          "The All tools belt follows the workspace's tool settings and cannot be edited. Clone it, or change a tool's availability.",
      });
    }
    const { tools, servers } = await readWorkspaceTools(tx, scope);
    const members = await readBeltMembers(tx, found.id);
    for (const change of input.changes) {
      await applyChange(tx, {
        scope,
        beltId: found.id,
        tools,
        servers,
        members,
        change,
        userId,
        now,
      });
    }
    const name = input.name ?? found.name;
    const description =
      input.description === undefined ? found.description : input.description;
    await tx
      .update(schema.toolbelts)
      .set({ name, description, updatedAt: now, updatedById: userId })
      .where(eq(schema.toolbelts.id, found.id));
    return { ...found, name, description, updatedAt: now };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      toolbeltId: belt.publicId,
      changes: input.changes.length,
    },
    "toolbelt.update: belt updated",
  );
  return { toolbelt: toolbeltRefOf(belt) };
};

async function applyChange(
  tx: Tx,
  args: {
    scope: { orgId: string; workspaceId: string };
    beltId: string;
    tools: readonly WorkspaceTool[];
    servers: ReadonlyMap<string, ToolServer>;
    /** The belt's members, kept current as each change applies. */
    members: Map<string, boolean>;
    change: ToolbeltChange;
    userId: string;
    now: Date;
  },
): Promise<void> {
  const { change, members } = args;
  if (change.op === "set_tool_active") {
    const tool = args.tools.find((t) => t.publicId === change.toolId);
    if (!tool) {
      throw new HandlerError({
        code: "not_found",
        reason: "tool_not_found",
        message: `No tool "${change.toolId}" in this workspace`,
      });
    }
    if (change.active && !tool.available) throw unavailable(tool);
    await upsertMembers(tx, args, [tool.id], change.active);
    return;
  }

  const key = resolveServerKey(args.servers, change.serverId);
  const serverTools = args.tools.filter((t) => serverKeyOf(t) === key);
  if (change.op === "remove_server") {
    const ids = serverTools.map((t) => t.id).filter((id) => members.has(id));
    if (ids.length === 0) return;
    await tx
      .delete(schema.toolbeltTools)
      .where(
        and(
          eq(schema.toolbeltTools.toolbeltId, args.beltId),
          inArray(schema.toolbeltTools.toolId, ids),
        ),
      );
    for (const id of ids) members.delete(id);
    return;
  }
  if (change.op === "add_server") {
    const ids = serverTools
      .filter((t) => t.available && !members.has(t.id))
      .map((t) => t.id);
    await upsertMembers(tx, args, ids, change.active);
    return;
  }
  // set_server_active: every tool the belt holds from the server. Turning one
  // on that is not available would show nothing, so it is refused by name.
  const held = serverTools.filter((t) => members.has(t.id));
  if (change.active) {
    const blocked = held.find((t) => !t.available);
    if (blocked) throw unavailable(blocked);
  }
  await upsertMembers(
    tx,
    args,
    held.map((t) => t.id),
    change.active,
  );
}

function unavailable(tool: Pick<WorkspaceTool, "name">): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "tool_unavailable",
    message: `Tool "${tool.name}" is not available to toolbelts in this workspace. An owner or admin can make it available.`,
  });
}

/** Insert or update the belt's rows for these tools, and the in-memory map with them. */
async function upsertMembers(
  tx: Tx,
  args: {
    scope: { orgId: string; workspaceId: string };
    beltId: string;
    members: Map<string, boolean>;
    userId: string;
    now: Date;
  },
  toolIds: readonly string[],
  active: boolean,
): Promise<void> {
  if (toolIds.length === 0) return;
  await tx
    .insert(schema.toolbeltTools)
    .values(
      toolIds.map((toolId) => ({
        orgId: args.scope.orgId,
        workspaceId: args.scope.workspaceId,
        toolbeltId: args.beltId,
        toolId,
        active,
        createdById: args.userId,
        updatedById: args.userId,
      })),
    )
    .onConflictDoUpdate({
      target: [schema.toolbeltTools.toolbeltId, schema.toolbeltTools.toolId],
      set: { active, updatedAt: args.now, updatedById: args.userId },
    });
  for (const toolId of toolIds) args.members.set(toolId, active);
}
