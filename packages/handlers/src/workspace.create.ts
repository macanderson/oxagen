// `create_workspace`: a workspace in the caller's org.
//
//   1. Role gate — assertOrgRole: org Owner or Admin, or the Owner of the
//      workspace the call is scoped to (the contract's defaultRoles; INV-29).
//      The gate refuses a context with no user, so the bootstrap below
//      always has a creator.
//   2. The slug is unique in the org: the pre-check and the unique index's
//      23505 both read as `conflict` / `slug_taken`.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { assertOrgRole } from "@oxagen/iam/org-role";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { bootstrapWorkspace } from "./workspace-bootstrap";

const slugTaken = (slug: string) =>
  new HandlerError({
    code: "conflict",
    reason: "slug_taken",
    message: `A workspace with the slug ${slug} already exists in this organization`,
  });

export const workspaceCreateHandler: CapabilityHandler<
  typeof workspaceCreate
> = async (input, ctx) => {
  await assertOrgRole(ctx, {
    org: ["Owner", "Admin"],
    workspace: ["Owner"],
  });
  const userId = ctx.userId as string;

  const tenant = await withTenantDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, ctx.orgId),
      columns: { slug: true },
    }),
  );
  if (!tenant) {
    logger.warn({ orgId: ctx.orgId }, "workspace.create: tenant not found");
    throw new HandlerError({ code: "not_found", reason: "org_not_found" });
  }

  // (org_id, slug) uniqueness pre-checked for a typed refusal. The composite
  // unique index still enforces it as a hard constraint.
  const existing = await withTenantDb((tx) =>
    tx.query.workspaces.findFirst({
      where: and(
        eq(schema.workspaces.orgId, ctx.orgId),
        eq(schema.workspaces.slug, input.slug),
      ),
      columns: { id: true },
    }),
  );
  if (existing) {
    logger.warn(
      { orgId: ctx.orgId, slug: input.slug },
      "workspace.create: slug already in use (pre-check)",
    );
    throw slugTaken(input.slug);
  }

  try {
    const ws = await withTenantDb((tx) =>
      bootstrapWorkspace({
        tx,
        orgId: ctx.orgId,
        userId,
        name: input.name,
        slug: input.slug,
      }),
    );

    logger.info(
      {
        workspaceId: ws.id,
        orgId: ctx.orgId,
        slug: ws.slug,
        surface: ctx.surface,
      },
      "workspace.create: workspace created successfully",
    );

    // Record security event for workspace creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "workspace.created",
      actorUserId: userId,
      orgId: ctx.orgId,
      workspaceId: ws.id,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error(
        { err, orgId: ctx.orgId, workspaceId: ws.id },
        "workspace.create: failed to record security event",
      );
    });

    return {
      publicId: ws.publicId,
      name: ws.name,
      slug: ws.slug,
      orgSlug: tenant.slug,
      createdAt: ws.createdAt.toISOString(),
    };
  } catch (err) {
    if (isUniqueViolation(err)) {
      logger.warn(
        { orgId: ctx.orgId, slug: input.slug },
        "workspace.create: slug conflict (race)",
      );
      throw slugTaken(input.slug);
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "workspace.create: transaction failed",
    );
    throw err;
  }
};
