// get_nav_counts: the sidebar's three counts. Approvals are counted with the
// predicate list_approvals pages on (unresolved, unexpired, this workspace);
// proposals and incidents are null because rev1 has no store for either
// (apps/app/ARCHITECTURE.md §1.2), and a null renders as no badge.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, sql } from "drizzle-orm";

const ar = schema.approvalRequests;

export const shellNavCountsGetHandler: CapabilityHandler<
  typeof shellNavCountsGet
> = async (_input, ctx) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ pending: sql<number>`count(*)::int`.mapWith(Number) })
      .from(ar)
      .where(
        and(
          eq(ar.orgId, ctx.orgId),
          eq(ar.workspaceId, ctx.workspaceId),
          isNull(ar.resolution),
          sql`${ar.expiresAt} > now()`,
        ),
      ),
  );
  // count(*) always answers one row; a missing row is a count nobody read,
  // and null renders as no badge rather than a fabricated zero.
  return {
    approvals: row === undefined ? null : row.pending,
    proposals: null,
    incidents: null,
  };
};
