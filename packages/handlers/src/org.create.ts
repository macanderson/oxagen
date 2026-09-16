import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import { organizationCreate } from "@oxagen/oxagen/contracts/org.create";
import {
  schema,
  withSystemDb,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { eq } from "drizzle-orm";
import { logger } from "./logger";
import { bootstrapOrgIAM } from "./iam-provision";
import { openOnboardingGate } from "./lib/onboarding";
import { bootstrapWorkspace } from "./workspace-bootstrap";

/**
 * The org bootstrap: the organization row, the creator's owner membership,
 * the IAM roles and grants, the first workspace with everything a workspace
 * needs, and the onboarding gate opened on that workspace (#2967: the
 * organization exists, so the gate is at `wrap` with its 14-day provisional
 * window), in one system transaction. Nothing billing-shaped is written
 * (ADR-055 §3.9 item 14): the org's assistant balance starts at zero, and the
 * billing settings row appears on the first write that needs it.
 */
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
  const userId = ctx.userId;
  const slugTaken = () =>
    new HandlerError({
      code: "conflict",
      reason: "slug_taken",
      message: `slug "${input.slug}" already in use`,
    });
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
  if (existing) throw slugTaken();

  try {
    const created = await withSystemDb(async (tx) => {
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
          createdById: userId,
          updatedById: userId,
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
        userId,
        role: "owner",
        joinedAt: new Date(),
        createdById: userId,
        updatedById: userId,
      });

      // Bootstrap full IAM state for the org — system roles, owner principal,
      // owner role assignment, and role_grants from capability defaultRoles.
      // Runs inside the same transaction so the org is never visible without
      // the owner having access (atomic with the org creation).
      await bootstrapOrgIAM({
        orgId: org.id,
        ownerUserId: userId,
        actorUserId: userId,
        tx,
      });

      // The first workspace, on the same transaction: an org with no
      // workspace has no page to land on.
      const workspace = await bootstrapWorkspace({
        tx,
        orgId: org.id,
        userId,
        name: input.workspace.name,
        slug: input.workspace.slug,
      });

      await openOnboardingGate(tx, {
        orgId: org.id,
        workspaceId: workspace.id,
        now: org.createdAt,
      });

      return { org, workspace };
    });

    logger.info(
      {
        orgId: created.org.id,
        slug: created.org.slug,
        workspaceId: created.workspace.id,
        surface: ctx.surface,
      },
      "organization.create: organization created successfully",
    );
    // Record security event for org creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "organization.created",
      actorUserId: userId,
      orgId: created.org.id,
      workspaceId: null,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: created.org.id },
        "organization.create: failed to record security event",
      );
    });

    return {
      publicId: created.org.publicId,
      name: created.org.name,
      slug: created.org.slug,
      type: created.org.type,
      createdAt: created.org.createdAt.toISOString(),
      workspace: {
        publicId: created.workspace.publicId,
        slug: created.workspace.slug,
      },
    };
  } catch (err) {
    if (isUniqueViolation(err, "organizations_slug_idx")) {
      logger.warn(
        { slug: input.slug, orgId: ctx.orgId },
        "organization.create: slug conflict",
      );
      throw slugTaken();
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "organization.create: transaction failed",
    );
    throw err;
  }
};
