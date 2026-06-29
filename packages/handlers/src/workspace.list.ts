import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "./logger";

/**
 * List the workspaces inside one organization the caller belongs to.
 *
 * tenancy: system bypass via withSystemDb — this is a pre-workspace call (the
 * user picked an org but hasn't scoped to a workspace yet). We MUST gate it
 * explicitly: resolve the org by slug, then confirm the caller has an org_users
 * row before listing any workspace. A non-member gets a not-a-member error, so
 * the bypass can never leak another tenant's workspaces. The caller's own
 * workspace role is left-joined (null when they're an org admin with no direct
 * workspace membership).
 */
export const workspaceListHandler: CapabilityHandler<typeof workspaceList> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn("workspace.list: rejected — no authenticated user");
    throw new Error("workspace.list requires an authenticated user");
  }
  return withSystemDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: and(
        eq(schema.organizations.slug, input.orgSlug),
        ne(schema.organizations.status, "deleted"),
      ),
      columns: { id: true, publicId: true, slug: true, name: true },
    });
    if (!org) {
      throw new Error(`Organization "${input.orgSlug}" not found`);
    }
    // Authorization gate: the caller must be a member of this org.
    const membership = await tx.query.orgUsers.findFirst({
      where: and(
        eq(schema.orgUsers.orgId, org.id),
        eq(schema.orgUsers.userId, ctx.userId!),
      ),
      columns: { role: true },
    });
    if (!membership) {
      throw new Error(`You are not a member of organization "${input.orgSlug}"`);
    }
    const rows = await tx
      .select({
        id: schema.workspaces.id,
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        name: schema.workspaces.name,
        role: schema.workspaceUsers.role,
      })
      .from(schema.workspaces)
      .leftJoin(
        schema.workspaceUsers,
        and(
          eq(schema.workspaceUsers.workspaceId, schema.workspaces.id),
          eq(schema.workspaceUsers.userId, ctx.userId!),
        ),
      )
      .where(eq(schema.workspaces.orgId, org.id));
    return {
      organization: {
        id: org.id,
        publicId: org.publicId,
        slug: org.slug,
        name: org.name,
      },
      workspaces: rows.map((r) => ({
        id: r.id,
        publicId: r.publicId,
        slug: r.slug,
        name: r.name,
        role: r.role ?? null,
      })),
    };
  });
};
