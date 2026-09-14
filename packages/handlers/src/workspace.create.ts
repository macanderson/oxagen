import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { schema, withTenantDb, isUniqueViolation } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { bootstrapWorkspace } from "./workspace-bootstrap";

export const workspaceCreateHandler: CapabilityHandler<
  typeof workspaceCreate
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "workspace.create: rejected — no authenticated user",
    );
    throw new Error("workspace.create requires an authenticated user");
  }
  const userId = ctx.userId;

  const tenant = await withTenantDb((tx) =>
    tx.query.organizations.findFirst({
      where: eq(schema.organizations.id, ctx.orgId),
      columns: { slug: true },
    }),
  );
  if (!tenant) {
    logger.warn({ orgId: ctx.orgId }, "workspace.create: tenant not found");
    throw new Error("tenant not found");
  }

  // (org_id, slug) uniqueness pre-checked for friendly errors. The
  // composite unique index still enforces it as a hard constraint.
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
    throw new Error(`slug "${input.slug}" already in use for this tenant`);
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
      throw new Error(`slug "${input.slug}" already in use for this tenant`);
    }
    logger.error(
      { err, orgId: ctx.orgId },
      "workspace.create: transaction failed",
    );
    throw err;
  }
};
