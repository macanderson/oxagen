// The finding claims the Spend page's waste and unproductive reads share
// (ADR-208, #5294). `readCauseClaims` reads the claims behind the unproductive
// spend headline, as `readUnproductiveClaims` in @oxagen/billing reads them,
// with the kind and basis of the finding that claims each call. `list_waste`
// splits the same calls by cause with them. `countFindingsOutside` counts the
// open findings that count no call in a window because their calls ran
// outside it: the Findings tab lists those findings, and no figure for the
// window counts their calls.
import { type CostBasis, inAppRunTotal } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { WASTE_CLAIM_CAUSES } from "@oxagen/oxagen/contracts/spend.waste";
import {
  and,
  eq,
  exists,
  gte,
  inArray,
  lt,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";

export type ClaimScope = { orgId: string; workspaceId: string };
export type ClaimWindow = { start: Date; end: Date };

/** One claimed call, with the kind and basis of the finding that claims it. */
export type CauseClaim = {
  /** 1, 7, or 8; the lowest claim on a call counts it. */
  detector: number;
  kind: string;
  runId: string;
  frameKey: string;
  costMicros: bigint;
  currency: string;
  /** The finding's saving basis: the fold of the bases of the calls it prices. */
  basis: CostBasis;
};

const claims = schema.findingClaims;
const findings = schema.findings;
const totals = schema.runTotals;

/**
 * The calls that open and applied findings claim and that ran in the window,
 * as the headline reads them, with each claim's finding kind and basis. A
 * dismissed finding's claims do not count.
 *
 * A call of the in-app assistant's runs is left out (ADR-235, 2026-10-02
 * amendment), as every list that names runs leaves it out. The findings pass
 * has read no assistant run since that amendment, so for the claims it has
 * written since then this read and the headline add the same calls. A claim
 * written before it, on an assistant run, counts in the headline until the
 * next pass rewrites its finding.
 */
export async function readCauseClaims(
  scope: ClaimScope,
  window: ClaimWindow,
): Promise<CauseClaim[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        detector: claims.detector,
        kind: findings.kind,
        runId: claims.runId,
        frameKey: claims.frameKey,
        costMicros: claims.costMicros,
        currency: claims.currency,
        basis: findings.savingBasis,
      })
      .from(claims)
      .innerJoin(findings, eq(findings.id, claims.findingId))
      // `inAppRunTotal` reads the run's row. `run_id` is unique on
      // `cost.run_totals`, so the join adds no claim twice, and a claim whose
      // run has no row is kept.
      .leftJoin(
        totals,
        and(
          eq(totals.runId, claims.runId),
          eq(totals.orgId, claims.orgId),
          eq(totals.workspaceId, claims.workspaceId),
        ),
      )
      .where(
        and(
          eq(claims.orgId, scope.orgId),
          eq(claims.workspaceId, scope.workspaceId),
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          gte(claims.frameAt, window.start),
          lt(claims.frameAt, window.end),
          inArray(findings.status, ["open", "applied"]),
          sql`not ${inAppRunTotal()}`,
        ),
      ),
  );
  return rows.map((r) => ({ ...r, basis: r.basis as CostBasis }));
}

/** The finding kinds whose findings claim calls: detectors 1, 7, and 8. */
const CLAIMING_KINDS: readonly string[] = WASTE_CLAIM_CAUSES.flatMap((c) => [
  ...c.kinds,
]);

/**
 * The open findings of the claiming kinds that count no call in the window:
 *
 * - one that claims calls, all of them outside the window;
 * - one that claims none and whose own window lies wholly outside it. A
 *   finding written before `cost.finding_claims` existed has no claim rows,
 *   and a pass whose window ended before this one began cannot have claimed
 *   a call inside it.
 *
 * A finding with calls on both sides of the window's edge is not counted,
 * since the window's figures count its calls inside. A finding with no claim
 * rows whose window overlaps this one is not counted either: nothing says
 * where its calls ran.
 */
export async function countFindingsOutside(
  scope: ClaimScope,
  window: ClaimWindow,
): Promise<number> {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({ findings: sql<number>`count(*)::int`.mapWith(Number) })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          eq(findings.status, "open"),
          inArray(findings.kind, [...CLAIMING_KINDS]),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(claims)
              .where(
                and(
                  eq(claims.findingId, findings.id),
                  gte(claims.frameAt, window.start),
                  lt(claims.frameAt, window.end),
                ),
              ),
          ),
          or(
            exists(
              tx
                .select({ one: sql`1` })
                .from(claims)
                .where(eq(claims.findingId, findings.id)),
            ),
            lte(findings.windowEnd, window.start),
            gte(findings.windowStart, window.end),
          ),
        ),
      ),
  );
  return row?.findings ?? 0;
}
