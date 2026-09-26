// get_nav_counts: the sidebar's three counts, each read from the store that
// owns it. Fleet and Steering count this workspace, in one tenant-scoped
// transaction; Audit is an organization page, so its count reads the
// organization through the org-wide seam (ADR-086), still fenced to this org.
//
// - approvals: the predicate list_approvals pages on (unresolved, unexpired,
//   this workspace), in agent.approval_requests.
// - proposals: open steering proposals in agent.context_proposals, the rows
//   list_proposals returns that have not merged and were not rejected.
// - incidents: open critical incidents in tacho.incidents across the
//   organization, the rows list_incidents returns with `open: true` at
//   severity 10, summed over the organization's workspaces.
//
// count(*) always answers one row. A missing row is a count nobody read, and
// it comes back null so the app draws "not recorded" rather than a zero.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { schema, withOrgDb, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";

const ar = schema.approvalRequests;
const cp = schema.contextProposals;
const inc = schema.tachoIncidents;

/** Proposal statuses that close a proposal: nothing waits on a person. */
export const CLOSED_PROPOSAL_STATUSES = ["merged", "rejected"] as const;
/** The severity the Audit nav counts: critical only (CHECK IN (1, 3, 10)). */
export const CRITICAL_SEVERITY = 10;

const counted = sql<number>`count(*)::int`.mapWith(Number);

function first(rows: readonly { n: number }[]): number | null {
  const [row] = rows;
  return row === undefined ? null : row.n;
}

export const shellNavCountsGetHandler: CapabilityHandler<
  typeof shellNavCountsGet
> = async (_input, ctx) => {
  const { approvals, proposals } = await withTenantDb(async (tx) => ({
    approvals: await tx
      .select({ n: counted })
      .from(ar)
      .where(
        and(
          eq(ar.orgId, ctx.orgId),
          eq(ar.workspaceId, ctx.workspaceId),
          isNull(ar.resolution),
          sql`${ar.expiresAt} > now()`,
        ),
      ),
    proposals: await tx
      .select({ n: counted })
      .from(cp)
      .where(
        and(
          eq(cp.orgId, ctx.orgId),
          eq(cp.workspaceId, ctx.workspaceId),
          notInArray(cp.status, [...CLOSED_PROPOSAL_STATUSES]),
        ),
      ),
  }));
  const incidents = await withOrgDb((tx) =>
    tx
      .select({ n: counted })
      .from(inc)
      .where(
        and(
          eq(inc.orgId, ctx.orgId),
          eq(inc.severity, CRITICAL_SEVERITY),
          isNull(inc.resolvedAt),
        ),
      ),
  );
  return {
    approvals: first(approvals),
    // Placeholder until the interjections read lands (#3839): null renders
    // "not recorded", never a zero.
    interjections: null,
    proposals: first(proposals),
    incidents: first(incidents),
  };
};
