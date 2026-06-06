import type { CapabilityHandler } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/organization.create";
import { db, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { grantFreeCredits } from "@oxagen/billing";
import { logger } from "./logger";
import { bootstrapOrgIAM } from "./iam-provision";

// Postgres unique_violation. Two concurrent creates with the same slug can
// both pass the pre-check before either insert lands; the loser hits the
// citext unique index and must surface the same friendly error, not a 500.
function isSlugConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export const organizationCreateHandler: CapabilityHandler<typeof organizationCreate> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "organization.create: rejected — no authenticated user");
    throw new Error("organization.create requires an authenticated user");
  }
  // tenancy: unscoped seam (creates the org's own root row — the new org does not
  // exist yet and ctx.orgId is the caller's current org, not the new one) — OXA-1515
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
  let result: { publicId: string; name: string; slug: string; type: string; createdAt: string };

  try {
    const txResult = await d.transaction(async (tx) => {
      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.name,
          slug: input.slug,
          planType: input.planSlug,
          status: "active",
          type: input.type,
          // Business-only fields: contract superRefine guarantees these are
          // undefined for personal accounts, so the DB columns stay null.
          website: input.type === "business" ? (input.website ?? null) : null,
          industry: input.type === "business" ? (input.industry ?? null) : null,
          employeeSize: input.type === "business" ? (input.employeeSize ?? null) : null,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning({
          publicId: schema.organizations.publicId,
          name: schema.organizations.name,
          slug: schema.organizations.slug,
          type: schema.organizations.type,
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

      // Bootstrap full IAM state for the org — system roles, owner principal,
      // owner role assignment, and role_grants from capability defaultRoles.
      // Runs inside the same transaction so the org is never visible without
      // the owner having access (atomic with the org creation).
      await bootstrapOrgIAM({
        orgId: org.id,
        ownerUserId: ctx.userId!,
        actorUserId: ctx.userId!,
        tx,
      });

      // Persist billing profile when either billing email or address is supplied.
      // A missing profile simply means not yet collected; the org itself is valid.
      // Country code is normalised to uppercase here (the contract validates length
      // only; the uppercase transform was removed to avoid Zod inference issues).
      if (input.billingEmail !== undefined || input.billingAddress !== undefined) {
        await tx.insert(schema.orgBillingProfiles).values({
          orgId: org.id,
          billingEmail: input.billingEmail ?? null,
          addressLine1: input.billingAddress?.line1 ?? null,
          addressLine2: input.billingAddress?.line2 ?? null,
          addressCity: input.billingAddress?.city ?? null,
          // Only uppercase for US (2-letter state codes); non-US regions are
          // free-text (e.g. "Île-de-France") and must not be forcibly uppercased.
          addressRegion:
            input.billingAddress?.country?.toUpperCase() === "US"
              ? (input.billingAddress.region?.toUpperCase() ?? null)
              : (input.billingAddress?.region ?? null),
          addressPostalCode: input.billingAddress?.postalCode ?? null,
          addressCountry: input.billingAddress?.country.toUpperCase() ?? null,
          addressPlaceId: input.billingAddress?.placeId ?? null,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        });
      }

      return {
        publicId: org.publicId,
        name: org.name,
        slug: org.slug,
        type: org.type,
        createdAt: org.createdAt.toISOString(),
        id: org.id,
      };
    });

    orgId = txResult.id;
    result = {
      publicId: txResult.publicId,
      name: txResult.name,
      slug: txResult.slug,
      type: txResult.type,
      createdAt: txResult.createdAt,
    };
    logger.info(
      { orgId: txResult.id, slug: txResult.slug, surface: ctx.surface },
      "organization.create: organization created successfully",
    );
  } catch (err) {
    if (isSlugConflict(err)) {
      logger.warn({ slug: input.slug, orgId: ctx.orgId }, "organization.create: slug conflict");
      throw new Error(`slug "${input.slug}" already in use`);
    }
    logger.error({ err, orgId: ctx.orgId }, "organization.create: transaction failed");
    throw err;
  }

  // Grant the free $5 (500 credits) signup bonus AFTER the org transaction
  // commits so a billing failure never rolls back the org creation itself.
  // grantFreeCredits is idempotent — safe to re-run on retries.
  await grantFreeCredits(orgId).catch((err: unknown) => {
    // Log but do not fail org creation. The grant can be re-applied manually.
    logger.error(
      { err, orgId },
      "organization.create: grantFreeCredits failed — org created, credits not granted",
    );
  });

  return result;
};
