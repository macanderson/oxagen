import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { schema, withTenantDb } from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

// Postgres unique_violation. Two concurrent creates with the same (orgId, slug)
// can both pass the pre-check before either insert lands; the loser hits the
// unique index and must surface the same friendly error, not a 500.
function isSlugConflict(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

export const workspaceCreateHandler: CapabilityHandler<typeof workspaceCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "workspace.create: rejected — no authenticated user");
    throw new Error("workspace.create requires an authenticated user");
  }

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
    logger.warn({ orgId: ctx.orgId, slug: input.slug }, "workspace.create: slug already in use (pre-check)");
    throw new Error(`slug "${input.slug}" already in use for this tenant`);
  }

  let workspaceId: string = "";
  try {
    const result = await withTenantDb(async (tx) => {
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

      const result = {
        publicId: ws.publicId,
        name: ws.name,
        slug: ws.slug,
        orgSlug: tenant.slug,
        createdAt: ws.createdAt.toISOString(),
      };
      logger.info(
        { workspaceId: ws.id, orgId: ctx.orgId, slug: ws.slug, surface: ctx.surface },
        "workspace.create: workspace created successfully",
      );
      workspaceId = ws.id;
      return result;
    });

    // Record security event for workspace creation (privileged mutation).
    emitSecurityEventAsync({
      eventType: "workspace.created",
      actorUserId: ctx.userId!,
      orgId: ctx.orgId,
      workspaceId,
      outcome: "success",
      capability: null,
      ip: null,
      userAgent: null,
      requestId: ctx.requestId,
    }).catch((err: unknown) => {
      logger.error({ err, orgId: ctx.orgId, workspaceId }, "workspace.create: failed to record security event");
    });

    return result;
  } catch (err) {
    if (isSlugConflict(err)) {
      logger.warn({ orgId: ctx.orgId, slug: input.slug }, "workspace.create: slug conflict (race)");
      throw new Error(`slug "${input.slug}" already in use for this tenant`);
    }
    logger.error({ err, orgId: ctx.orgId }, "workspace.create: transaction failed");
    throw err;
  }
};
