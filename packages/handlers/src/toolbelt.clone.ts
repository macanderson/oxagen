// audit-exempt: a toolbelt narrows what an agent is shown and grants nothing, and the security event taxonomy has no toolbelt type; the kernel capability.invoke_* audit covers the write.
//
// toolbelt.clone.ts — copy a toolbelt into a new custom belt (ADR-192, #4369).
//
// Role gate: the contract's roles (INV-29). The clone holds every tool the
// source holds, each active as it is in the source:
//
// - From the All tools belt: every available tool, active as its workspace
//   default says.
// - From a custom belt: every row the source has, as the source left it. A
//   row for a tool that is unavailable now is copied too, so the tool comes
//   back in the clone as the source kept it once it is made available again.
//
// The slug is the caller's or `slugFromName(name)`. `all-tools` belongs to
// the All tools belt, and a slug another live belt holds is refused with
// `conflict`, reason `toolbelt_slug_taken`.
import { isUniqueViolation, schema, withTenantDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import { slugFromName } from "@oxagen/oxagen/contracts/runtime.shared";
import { toolbeltClone } from "@oxagen/oxagen/contracts/toolbelt.clone";
import { TOOLBELT_SLUG_MAX } from "@oxagen/oxagen/contracts/toolbelt.shared";
import { and, eq, isNull } from "drizzle-orm";
import { contractRoleRequirement } from "./lib/capability-role-guard";
import {
  ALL_TOOLS_SLUG,
  readBeltMembers,
  readWorkspaceTools,
  requireToolbelt,
  toolbeltRefOf,
} from "./lib/toolbelts";
import { logger } from "./logger";

function slugTaken(slug: string): HandlerError {
  return new HandlerError({
    code: "conflict",
    reason: "toolbelt_slug_taken",
    message: `Another toolbelt in this workspace uses the slug "${slug}". Choose another slug.`,
  });
}

export const toolbeltCloneHandler: CapabilityHandler<
  typeof toolbeltClone
> = async (input, ctx) => {
  const actingUserId = await resolveActingUserId(ctx);
  await assertOrgRole(
    { ...ctx, userId: actingUserId },
    contractRoleRequirement(toolbeltClone),
  );
  // assertOrgRole refused a call with no acting user.
  const userId = actingUserId as string;

  const slug = input.slug ?? slugFromName(input.name, TOOLBELT_SLUG_MAX);
  if (slug === "") {
    throw new HandlerError({
      code: "conflict",
      reason: "toolbelt_slug_empty",
      message:
        "The name has no letter or digit to make a slug from. Type a slug.",
    });
  }
  if (slug === ALL_TOOLS_SLUG) throw slugTaken(slug);

  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const result = await withTenantDb(async (tx) => {
    const source = await requireToolbelt(tx, scope, input.toolbeltId);
    const [held] = await tx
      .select({ id: schema.toolbelts.id })
      .from(schema.toolbelts)
      .where(
        and(
          eq(schema.toolbelts.orgId, scope.orgId),
          eq(schema.toolbelts.workspaceId, scope.workspaceId),
          eq(schema.toolbelts.slug, slug),
          isNull(schema.toolbelts.deletedAt),
        ),
      )
      .limit(1);
    if (held) throw slugTaken(slug);

    const { tools } = await readWorkspaceTools(tx, scope);
    const inWorkspace = new Set(tools.map((tool) => tool.id));
    const members =
      source.kind === "all_tools"
        ? tools
            .filter((tool) => tool.available)
            .map((tool) => ({ toolId: tool.id, active: tool.defaultActive }))
        : [...(await readBeltMembers(tx, source.id))]
            .filter(([toolId]) => inWorkspace.has(toolId))
            .map(([toolId, active]) => ({ toolId, active }));

    let belt: { id: string; publicId: string } | undefined;
    try {
      [belt] = await tx
        .insert(schema.toolbelts)
        .values({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          name: input.name,
          slug,
          description: input.description ?? null,
          kind: "custom",
          clonedFromId: source.id,
          createdById: userId,
          updatedById: userId,
        })
        .returning({
          id: schema.toolbelts.id,
          publicId: schema.toolbelts.publicId,
        });
    } catch (err) {
      if (isUniqueViolation(err, "toolbelts_workspace_slug_uniq")) {
        throw slugTaken(slug);
      }
      throw err;
    }
    if (!belt) throw new Error("toolbelts insert returned no row");
    const beltId = belt.id;

    if (members.length > 0) {
      await tx.insert(schema.toolbeltTools).values(
        members.map((member) => ({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
          toolbeltId: beltId,
          toolId: member.toolId,
          active: member.active,
          createdById: userId,
          updatedById: userId,
        })),
      );
    }
    return {
      belt: {
        id: belt.id,
        publicId: belt.publicId,
        name: input.name,
        slug,
        kind: "custom" as const,
        description: input.description ?? null,
        clonedFromId: source.id,
        updatedAt: new Date(),
      },
      source,
      copied: members.length,
    };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      toolbeltId: result.belt.publicId,
      source: result.source.publicId,
      copied: result.copied,
    },
    "toolbelt.clone: belt cloned",
  );
  return { toolbelt: toolbeltRefOf(result.belt) };
};
