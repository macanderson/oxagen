import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import {
  schema,
  withTenantDb,
  isUniqueViolation,
  deriveNamespace,
} from "@oxagen/database";
import { emitSecurityEventAsync } from "@oxagen/database/security";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";
import { bootstrapWorkspaceAgents } from "./workspace-agents";
import { seedWorkspaceDefaultRegistry } from "./workspace-registry-seed";
import { seedWorkspaceDefaultCapabilities } from "./workspace-capability-seed";
import { seedWorkspaceDefaultSkills } from "./skill-workspace-seed";
import { seedWorkspaceDefaultEnvironment } from "./workspace-environment-seed";

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

  let workspaceId: string = "";
  try {
    const result = await withTenantDb(async (tx) => {
      // Derive the immutable namespace from the slug, unique WITHIN this org
      // (workspace namespaces are per-org, like slugs). The (org_id, namespace)
      // unique index is the authoritative guard against a concurrent-create race.
      const takenNamespaces = new Set(
        (
          await tx
            .select({ namespace: schema.workspaces.namespace })
            .from(schema.workspaces)
            .where(eq(schema.workspaces.orgId, ctx.orgId))
        ).map((r) => r.namespace.toLowerCase()),
      );
      const namespace = deriveNamespace(input.slug, takenNamespaces);

      const [ws] = await tx
        .insert(schema.workspaces)
        .values({
          orgId: ctx.orgId,
          name: input.name,
          slug: input.slug,
          namespace,
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

      await bootstrapWorkspaceAgents({
        workspaceId: ws.id,
        orgId: ctx.orgId,
        userId: ctx.userId!,
        tx,
      });

      const result = {
        publicId: ws.publicId,
        name: ws.name,
        slug: ws.slug,
        orgSlug: tenant.slug,
        createdAt: ws.createdAt.toISOString(),
      };
      logger.info(
        {
          workspaceId: ws.id,
          orgId: ctx.orgId,
          slug: ws.slug,
          surface: ctx.surface,
        },
        "workspace.create: workspace created successfully",
      );
      workspaceId = ws.id;
      return result;
    });

    // Seed the default MCP registry for the new workspace (idempotent).
    await seedWorkspaceDefaultRegistry({ orgId: ctx.orgId, workspaceId });

    // Seed the default first-party capability packs (documents/media) so the
    // in-app agent can invoke them immediately without capability_not_installed.
    await seedWorkspaceDefaultCapabilities({ orgId: ctx.orgId, workspaceId });

    // Seed workspace-owned editable copies of all builtin skill templates so
    // agents can invoke them immediately without a separate install (idempotent).
    await seedWorkspaceDefaultSkills({ orgId: ctx.orgId, workspaceId });

    // Seed the default environment so runs always resolve to a default (idempotent).
    await seedWorkspaceDefaultEnvironment({ orgId: ctx.orgId, workspaceId });

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
      logger.error(
        { err, orgId: ctx.orgId, workspaceId },
        "workspace.create: failed to record security event",
      );
    });

    return result;
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
