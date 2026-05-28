import type { CapabilityHandler } from "@oxagen/oxagen";
import { tenantCreate } from "@oxagen/oxagen/contracts/tenant.create";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";

export const tenantCreateHandler: CapabilityHandler<typeof tenantCreate> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error("tenant.create requires an authenticated user");
  }
  const d = db();
  // citext unique index makes slug collision a constraint violation; we
  // pre-check to return a friendly error rather than relying on the DB
  // error message shape.
  const existing = await d.query.tenants.findFirst({
    where: eq(schema.tenants.slug, input.slug),
    columns: { id: true },
  });
  if (existing) {
    throw new Error(`slug "${input.slug}" already in use`);
  }

  return await d.transaction(async (tx) => {
    const [tenant] = await tx
      .insert(schema.tenants)
      .values({
        name: input.name,
        slug: input.slug,
        planType: input.planSlug,
        status: "active",
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning({
        publicId: schema.tenants.publicId,
        name: schema.tenants.name,
        slug: schema.tenants.slug,
        createdAt: schema.tenants.createdAt,
        id: schema.tenants.id,
      });

    if (!tenant) throw new Error("tenant insert returned no row");

    // Creator becomes owner. Membership row paired in same tx so callers
    // never see a tenant they cannot reach.
    await tx.insert(schema.tenantUsers).values({
      tenantId: tenant.id,
      userId: ctx.userId!,
      role: "owner",
      joinedAt: new Date(),
      createdByUserId: ctx.userId,
      updatedByUserId: ctx.userId,
    });

    return {
      publicId: tenant.publicId,
      name: tenant.name,
      slug: tenant.slug,
      createdAt: tenant.createdAt.toISOString(),
    };
  });
};
