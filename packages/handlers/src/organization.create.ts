import type { CapabilityHandler } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";

export const organizationCreateHandler: CapabilityHandler<typeof organizationCreate> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error("organization.create requires an authenticated user");
  }
  const d = db();
  // citext unique index makes slug collision a constraint violation; we
  // pre-check to return a friendly error rather than relying on the DB
  // error message shape.
  const existing = await d.query.organizations.findFirst({
    where: eq(schema.organizations.slug, input.slug),
    columns: { id: true },
  });
  if (existing) {
    throw new Error(`slug "${input.slug}" already in use`);
  }

  return await d.transaction(async (tx) => {
    const [org] = await tx
      .insert(schema.organizations)
      .values({
        name: input.name,
        slug: input.slug,
        planType: input.planSlug,
        status: "active",
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({
        publicId: schema.organizations.publicId,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        createdAt: schema.organizations.createdAt,
        id: schema.organizations.id,
      });

    if (!org) throw new Error("organization insert returned no row");

    // Creator becomes owner. Membership row paired in same tx so callers
    // never see an org they cannot reach.
    await tx.insert(schema.orgUsers).values({
      orgId: org.id,
      userId: ctx.userId!,
      role: "owner",
      joinedAt: new Date(),
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    });

    return {
      publicId: org.publicId,
      name: org.name,
      slug: org.slug,
      createdAt: org.createdAt.toISOString(),
    };
  });
};
