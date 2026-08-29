import type { CapabilityHandler } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import {
  schema,
  withSystemDb,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { eq } from "drizzle-orm";
import { grantFreeCredits } from "@oxagen/billing";
import { logger } from "./logger";
import { bootstrapOrgIAM } from "./iam-provision";

export const organizationCreateHandler: CapabilityHandler<
  typeof organizationCreate
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "organization.create: rejected — no authenticated user",
    );
    throw new Error("organization.create requires an authenticated user");
  }
  // tenancy: system bypass via withSystemDb (bootstrap — creates the org's own root
  // rows; no tenant scope exists yet because the new org does not exist yet, and
  // ctx.orgId is the caller's current org, not the one being created) (see docs/specs/tenancy-rls/spec.md)
  // Fast-path friendly error for the common (non-racing) case; the unique
  // index + the catch below are the authoritative guard against the race.
  const existing = await withSystemDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.slug, input.slug),
      columns: { id: true },
    }),
  );
  if (existing) {
    throw new Error(`slug "${input.slug}" already in use`);
  }

  let orgId: string;
  let result: {
    publicId: string;
    name: string;
    slug: string;
    type: string;
    createdAt: string;
  };

  try {
    const txResult = await withSystemDb(async (tx) => {
      // Derive the immutable, globally-unique namespace from the slug, avoiding
      // any namespace already taken. The unique index is the authoritative guard
      // against a concurrent-create race; this best-effort read just picks a
      // non-colliding value in the common case.
      const takenNamespaces = new Set(
        (
          await tx
            .select({ namespace: schema.organizations.namespace })
            .from(schema.organizations)
        ).map((r) => r.namespace.toLowerCase()),
      );
      const namespace = deriveNamespace(input.slug, takenNamespaces);

      const [org] = await tx
        .insert(schema.organizations)
        .values({
          name: input.name,
          slug: input.slug,
          namespace,
          planType: input.planSlug,
          status: "active",
          type: input.type,
          // Business-only fields: contract superRefine guarantees these are
          // undefined for personal accounts, so the DB columns stay null.
          website: input.type === "business" ? (input.website ?? null) : null,
          industry: input.type === "business" ? (input.industry ?? null) : null,
          employeeSize:
            input.type === "business" ? (input.employeeSize ?? null) : null,
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
    // Record security event for org creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "organization.created",
      actorUserId: ctx.userId!,
      orgId: txResult.id,
      workspaceId: null,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: txResult.id },
        "organization.create: failed to record security event",
      );
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.warn(
        { slug: input.slug, orgId: ctx.orgId },
        "organization.create: slug conflict",
      );
      throw new Error(`slug "${input.slug}" already in use`);
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "organization.create: transaction failed",
    );
    throw err;
  }

  // Grant the free $5 (500 credits) signup bonus AFTER the org transaction
  // commits so a billing failure never rolls back the org creation itself.
  // grantFreeCredits is idempotent — INSERT … ON CONFLICT DO NOTHING — so a
  // second attempt is always safe, even if the first partially succeeded.
  await grantFreeCredits(orgId).catch(async (firstErr: unknown) => {
    const firstErrMsg =
      firstErr instanceof Error
        ? `${firstErr.message}\n${firstErr.stack}`
        : String(firstErr);
    logger.warn(
      { err: firstErr, firstErrMsg, orgId },
      "organization.create: grantFreeCredits failed on first attempt — retrying once",
    );
    // One idempotent retry. If this also fails, log the error and continue so
    // the org creation itself is not surfaced as a failure to the caller.
    // The orgId is logged at error level so ops can re-run the grant manually.
    await grantFreeCredits(orgId).catch((retryErr: unknown) => {
      const retryErrMsg =
        retryErr instanceof Error
          ? `${retryErr.message}\n${retryErr.stack}`
          : String(retryErr);
      logger.error(
        { err: retryErr, retryErrMsg, orgId },
        "organization.create: grantFreeCredits failed after retry — org created, credits not granted; re-apply manually",
      );
    });
  });

  // Registries are per-(org, workspace); the default registry is seeded by
  // seedWorkspaceDefaultRegistry when the first workspace is created.

  return result;
};
