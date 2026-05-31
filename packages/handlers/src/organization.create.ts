import type { CapabilityHandler } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { grantFreeCredits } from "@oxagen/billing";

// Postgres unique_violation. Two concurrent creates with the same slug can
// both pass the pre-check before either insert lands; the loser hits the
// citext unique index and must surface the same friendly error, not a 500.
function isSlugConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export const organizationCreateHandler: CapabilityHandler<typeof organizationCreate> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error("organization.create requires an authenticated user");
  }
  const d = db();
  // Fast-path friendly error for the common (non-racing) case; the unique
  // index + the catch below are the authoritative guard against the race.
  const existing = await d.query.organizations.findFirst({
    where: eq(schema.organizations.slug, input.slug),
    columns: { id: true },
  });
  if (existing) {
    throw new Error(`slug "${input.slug}" already in use`);
  }

  let orgId: string;
  let result: { publicId: string; name: string; slug: string; createdAt: string };

  try {
    const txResult = await d.transaction(async (tx) => {
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
        id: org.id,
      };
    });

    orgId = txResult.id;
    result = {
      publicId: txResult.publicId,
      name: txResult.name,
      slug: txResult.slug,
      createdAt: txResult.createdAt,
    };
  } catch (err) {
    if (isSlugConflict(err)) {
      throw new Error(`slug "${input.slug}" already in use`);
    }
    throw err;
  }

  // Grant the free $5 (500 credits) signup bonus AFTER the org transaction
  // commits so a billing failure never rolls back the org creation itself.
  // grantFreeCredits is idempotent — safe to re-run on retries.
  await grantFreeCredits(orgId).catch((err) => {
    // Log but do not fail org creation. The grant can be re-applied manually.
    console.error("[org.create] grantFreeCredits failed — org created, credits not granted", {
      orgId,
      err,
    });
  });

  return result;
};
