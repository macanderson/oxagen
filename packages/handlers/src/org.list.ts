import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, isNull, ne } from "drizzle-orm";
import { logger } from "./logger";

/**
 * List the organizations the authenticated user belongs to.
 *
 * tenancy: system bypass via withSystemDb — this is a pre-org call (the user has
 * no active tenant scope yet), and the WHERE clause is keyed to the caller's own
 * userId, so it can only ever return the caller's own memberships. Deleted orgs
 * are filtered out; suspended ones remain visible so the user understands why
 * they can't act.
 *
 * Auth: supports both session auth (ctx.userId set) and API-key auth
 * (ctx.userId null, ctx.apiKeyId set). For API-key callers the effective user
 * is resolved from the key's created_by_user_id — matching the IAM layer's
 * "API key authorizes as its creator" invariant. The result is always scoped
 * to that one user's memberships; the caller can never cross-read another
 * user's org list.
 */
export const orgListHandler: CapabilityHandler<typeof orgList> = async (
  _input,
  ctx,
) => {
  // ── Resolve acting user ───────────────────────────────────────────────────
  // Session auth:  ctx.userId is the real user; use directly.
  // API-key auth:  ctx.userId is null; resolve from the key's createdByUserId.
  //                The auth middleware already validated the key before reaching
  //                this handler (401 for invalid/expired keys), so the DB row
  //                will almost always be present. A missing row (key deleted
  //                between auth and here, or no creator recorded) → treat as
  //                unauthenticated (throw rather than expose an empty list that
  //                might look like a success to the caller).
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
    logger.warn("org.list: rejected — no authenticated user");
    throw new Error("org.list requires an authenticated user");
  }

  // Capture into a const so the non-null narrowing survives into the nested
  // withSystemDb closure (TS won't carry property narrowing across the boundary).
  const resolvedUserId = userId;

  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.organizations.id,
        publicId: schema.organizations.publicId,
        slug: schema.organizations.slug,
        namespace: schema.organizations.namespace,
        name: schema.organizations.name,
        avatarUrl: schema.organizations.avatarUrl,
        role: schema.orgUsers.role,
      })
      .from(schema.orgUsers)
      .innerJoin(
        schema.organizations,
        eq(schema.organizations.id, schema.orgUsers.orgId),
      )
      .where(
        and(
          eq(schema.orgUsers.userId, resolvedUserId),
          ne(schema.organizations.status, "deleted"),
        ),
      ),
  );
  return {
    organizations: rows.map((r) => ({
      id: r.id,
      publicId: r.publicId,
      slug: r.slug,
      namespace: r.namespace,
      name: r.name,
      role: r.role,
      avatarUrl: r.avatarUrl ?? null,
    })),
  };
};
