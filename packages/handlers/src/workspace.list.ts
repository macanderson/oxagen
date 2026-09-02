import type { CapabilityHandler } from "@oxagen/oxagen";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";

/**
 * List the workspaces inside one organization the caller belongs to.
 *
 * tenancy: system bypass via withSystemDb — this is a pre-workspace call (the
 * user picked an org but hasn't scoped to a workspace yet). We MUST gate it
 * explicitly: resolve the org by slug, then confirm the caller has an org_users
 * row before listing any workspace. A non-member gets a not-a-member error, so
 * the bypass can never leak another tenant's workspaces. The caller's own
 * workspace role is left-joined (null when they're an org admin with no direct
 * workspace membership).
 *
 * Auth: supports both session auth (ctx.userId set) and API-key auth
 * (ctx.userId null, ctx.apiKeyId set). For API-key callers the effective user
 * is resolved from the key's created_by_user_id, matching the IAM layer's
 * "API key authorizes as its creator" invariant.
 */
export const workspaceListHandler: CapabilityHandler<
  typeof workspaceList
> = async (input, ctx) => {
  // ── Resolve acting user (same pattern as org.list) ───────────────────────
  let userId = ctx.userId;
  if (!userId && ctx.apiKeyId) {
    const keyRow = await withSystemDb((tx) =>
      tx
        .select({ createdByUserId: schema.apiKeys.createdByUserId })
        .from(schema.apiKeys)
        .where(
          and(
            eq(schema.apiKeys.id, ctx.apiKeyId!),
            isNull(schema.apiKeys.deletedAt),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null),
    );
    userId = keyRow?.createdByUserId ?? null;
  }

  if (!userId) {
    logger.warn("workspace.list: rejected — no authenticated user");
    throw new Error("workspace.list requires an authenticated user");
  }

  // Capture into a const so TS narrowing survives across the withSystemDb closure.
  const resolvedUserId = userId;

  return withSystemDb(async (tx) => {
    const org = await tx.query.organizations.findFirst({
      where: and(
        eq(schema.organizations.slug, input.orgSlug),
        ne(schema.organizations.status, "deleted"),
      ),
      columns: {
        id: true,
        publicId: true,
        slug: true,
        namespace: true,
        name: true,
      },
    });
    if (!org) {
      throw new Error(`Organization "${input.orgSlug}" not found`);
    }
    // Authorization gate: the caller must be a member of this org.
    const membership = await tx.query.orgUsers.findFirst({
      where: and(
        eq(schema.orgUsers.orgId, org.id),
        eq(schema.orgUsers.userId, resolvedUserId),
      ),
      columns: { role: true },
    });
    if (!membership) {
      throw new Error(
        `You are not a member of organization "${input.orgSlug}"`,
      );
    }
    const rows = await tx
      .select({
        id: schema.workspaces.id,
        publicId: schema.workspaces.publicId,
        slug: schema.workspaces.slug,
        namespace: schema.workspaces.namespace,
        name: schema.workspaces.name,
        role: schema.workspaceUsers.role,
      })
      .from(schema.workspaces)
      .leftJoin(
        schema.workspaceUsers,
        and(
          eq(schema.workspaceUsers.workspaceId, schema.workspaces.id),
          eq(schema.workspaceUsers.userId, resolvedUserId),
        ),
      )
      .where(eq(schema.workspaces.orgId, org.id));
    return {
      organization: {
        id: org.id,
        publicId: org.publicId,
        slug: org.slug,
        namespace: org.namespace,
        name: org.name,
      },
      workspaces: rows.map((r) => ({
        id: r.id,
        publicId: r.publicId,
        slug: r.slug,
        namespace: r.namespace,
        name: r.name,
        role: r.role ?? null,
      })),
    };
  });
};
