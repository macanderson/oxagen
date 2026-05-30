import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";

export const workspaceCreateHandler: CapabilityHandler<typeof workspaceCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) throw new Error("workspace.create requires an authenticated user");
  const d = db();

  const tenant = await d.query.organizations.findFirst({
    where: eq(schema.organizations.id, ctx.orgId),
    columns: { slug: true },
  });
  if (!tenant) throw new Error("tenant not found");

  // (org_id, slug) uniqueness pre-checked for friendly errors. The
  // composite unique index still enforces it as a hard constraint.
  const existing = await d.query.workspaces.findFirst({
    where: and(
      eq(schema.workspaces.orgId, ctx.orgId),
      eq(schema.workspaces.slug, input.slug),
    ),
    columns: { id: true },
  });
  if (existing) throw new Error(`slug "${input.slug}" already in use for this tenant`);

  return await d.transaction(async (tx) => {
    const [ws] = await tx
      .insert(schema.workspaces)
      .values({
        orgId: ctx.orgId,
        name: input.name,
        slug: input.slug,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({
        publicId: schema.workspaces.publicId,
        name: schema.workspaces.name,
        slug: schema.workspaces.slug,
        id: schema.workspaces.id,
        createdAt: schema.workspaces.createdAt,
      });

    if (!ws) throw new Error("workspace insert returned no row");

    await tx.insert(schema.workspaceUsers).values({
      workspaceId: ws.id,
      userId: ctx.userId!,
      role: "owner",
      joinedAt: new Date(),
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    });

    return {
      publicId: ws.publicId,
      name: ws.name,
      slug: ws.slug,
      orgSlug: tenant.slug,
      createdAt: ws.createdAt.toISOString(),
    };
  });
};
