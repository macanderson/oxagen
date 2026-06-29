import type { CapabilityHandler } from "@oxagen/oxagen";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { schema, withSystemDb } from "@oxagen/database";
import { and, eq, ne } from "drizzle-orm";
import { logger } from "./logger";

/**
 * List the organizations the authenticated user belongs to.
 *
 * tenancy: system bypass via withSystemDb — this is a pre-org call (the user has
 * no active tenant scope yet), and the WHERE clause is keyed to the caller's own
 * userId, so it can only ever return the caller's own memberships. Deleted orgs
 * are filtered out; suspended ones remain visible so the user understands why
 * they can't act.
 */
export const orgListHandler: CapabilityHandler<typeof orgList> = async (_input, ctx) => {
  if (!ctx.userId) {
    logger.warn("org.list: rejected — no authenticated user");
    throw new Error("org.list requires an authenticated user");
  }
  // Capture into a const so the non-null narrowing survives into the nested
  // withSystemDb closure (TS won't carry property narrowing across the boundary).
  const userId = ctx.userId;
  const rows = await withSystemDb((tx) =>
    tx
      .select({
        id: schema.organizations.id,
        publicId: schema.organizations.publicId,
        slug: schema.organizations.slug,
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
          eq(schema.orgUsers.userId, userId),
          ne(schema.organizations.status, "deleted"),
        ),
      ),
  );
  return {
    organizations: rows.map((r) => ({
      id: r.id,
      publicId: r.publicId,
      slug: r.slug,
      name: r.name,
      role: r.role,
      avatarUrl: r.avatarUrl ?? null,
    })),
  };
};
