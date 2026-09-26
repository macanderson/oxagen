// audit-exempt: read-only — answers the workspace's findings from cost.findings and the priced spend from cost.run_totals; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `list_findings` (ADR-062): the findings in one status with the totals the
// Spend page leads with. The saving is the sum of the listed findings' own
// figures. The annualised figure scales each finding's saving from its own
// window to 365 days and sums them, since a finding decided once cites only
// runs after the decision and covers a shorter window than the others. The
// share is that annualised saving over the workspace's priced spend across
// the findings' span, scaled the same way. A window or span shorter than
// ANNUALISED_WINDOW_MIN_DAYS scales as if it were that long: a finding decided
// once and re-proven minutes later covers minutes of runs, and scaling those
// to a year would multiply its saving by the tens of thousands. Every figure
// comes from the job's rows or the rollup, never from a guess.
//
// Given a run (#4001), it lists only the findings that cite that run, the
// totals cover those, and each finding answers what it cites there: the
// frames the Run page pins it to, or the run as a whole.
import { type CostBasis, divideHalfEven, foldBasis } from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  ANNUALISED_WINDOW_MIN_DAYS,
  findingList,
  type FindingListOutput,
} from "@oxagen/oxagen/contracts/finding.list";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import {
  citationOf,
  type FindingFilter,
  findingScope,
  type FindingRow,
  type FindingScope,
  operatorKeysOf,
  readFindingRows,
  toFinding,
} from "./finding.shared";

const DAY_MS = 86_400_000n;
const YEAR_MS = 365n * DAY_MS;
const MIN_WINDOW_MS = BigInt(ANNUALISED_WINDOW_MIN_DAYS) * DAY_MS;

/** The length a window annualises over: its own, or the minimum when shorter. */
const annualisedOver = (from: Date, to: Date): bigint => {
  const ms = BigInt(to.getTime() - from.getTime());
  return ms > MIN_WINDOW_MS ? ms : MIN_WINDOW_MS;
};

type PricedSpend = { micros: bigint; currency: string; basis: CostBasis };

type FindingListDeps = {
  readFindings: (
    scope: FindingScope,
    filter: FindingFilter,
  ) => Promise<FindingRow[]>;
  /** The priced spend of runs that started in [start, end); null when nothing was priced. */
  readPricedSpend: (
    scope: FindingScope,
    window: { start: Date; end: Date },
  ) => Promise<PricedSpend | null>;
};

async function readPricedSpend(
  scope: FindingScope,
  window: { start: Date; end: Date },
): Promise<PricedSpend | null> {
  const totals = schema.runTotals;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        basis: totals.costBasis,
        currency: totals.currency,
        micros: sql<string>`sum(${totals.costMicros})::text`,
      })
      .from(totals)
      .where(
        and(
          eq(totals.orgId, scope.orgId),
          eq(totals.workspaceId, scope.workspaceId),
          gte(totals.startedAt, window.start),
          lt(totals.startedAt, window.end),
          isNotNull(totals.costMicros),
        ),
      )
      .groupBy(totals.costBasis, totals.currency),
  );
  let spend: PricedSpend | null = null;
  for (const r of rows) {
    const basis = r.basis as CostBasis;
    spend =
      spend === null
        ? { micros: BigInt(r.micros), currency: r.currency, basis }
        : {
            micros: spend.micros + BigInt(r.micros),
            currency: spend.currency,
            basis: foldBasis(spend.basis, basis),
          };
  }
  return spend;
}

export function createFindingListHandler(
  deps: FindingListDeps,
): CapabilityHandler<typeof findingList> {
  return async (input, ctx): Promise<FindingListOutput> => {
    const scope = findingScope(ctx);
    const { runId } = input;
    const rows = await deps.readFindings(
      scope,
      runId === undefined
        ? { status: input.status }
        : { status: input.status, runId },
    );
    const counts = {
      findings: rows.length,
      high: rows.filter((r) => r.confidence === "high").length,
      medium: rows.filter((r) => r.confidence === "medium").length,
      operators: new Set(rows.flatMap((r) => operatorKeysOf(r))).size,
    };
    // A citation answers exactly when the read names a run.
    const findings = rows.map((row) =>
      runId === undefined
        ? toFinding(row)
        : { ...toFinding(row), citation: citationOf(row, runId) },
    );
    if (rows.length === 0)
      return {
        status: input.status,
        window: null,
        saving: null,
        spend: null,
        share: null,
        annualised: null,
        counts,
        findings,
      };

    let start = rows[0]!.windowStart;
    let end = rows[0]!.windowEnd;
    let savingMicros = 0n;
    let annualisedMicros = 0n;
    let basis: CostBasis | null = null;
    for (const r of rows) {
      if (r.windowStart < start) start = r.windowStart;
      if (r.windowEnd > end) end = r.windowEnd;
      savingMicros += r.estimatedSavingMicros;
      annualisedMicros += divideHalfEven(
        r.estimatedSavingMicros * YEAR_MS,
        annualisedOver(r.windowStart, r.windowEnd),
      );
      basis = foldBasis(basis, r.savingBasis as CostBasis);
    }
    const currency = rows[0]!.currency;
    const spend = await deps.readPricedSpend(scope, { start, end });
    const spanMs = annualisedOver(start, end);

    return {
      status: input.status,
      window: { from: start.toISOString(), to: end.toISOString() },
      saving: { micros: savingMicros.toString(), currency, basis: basis! },
      spend:
        spend === null
          ? null
          : {
              micros: spend.micros.toString(),
              currency: spend.currency,
              basis: spend.basis,
            },
      share:
        spend === null || spend.micros <= 0n
          ? null
          : Math.min(
              1,
              (Number(annualisedMicros) * Number(spanMs)) /
                (Number(spend.micros) * Number(YEAR_MS)),
            ),
      annualised: {
        micros: annualisedMicros.toString(),
        currency,
        basis: basis!,
      },
      counts,
      findings,
    };
  };
}

export const findingListHandler = createFindingListHandler({
  readFindings: readFindingRows,
  readPricedSpend,
});
