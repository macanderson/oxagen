// audit-exempt: read-only — answers the workspace's unproductive spend from cost.finding_claims and cost.findings, and its priced spend from cost.run_totals and the frame store; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// `get_unproductive_spend` (spend spec, Counting): the headline the Spend
// page leads with. The claims come from `readUnproductiveClaims` and count
// through `countClaims`, the reader and the count `get_operator_ranking`
// totals, so the hero and the ranking's Total row read one number for one
// period (rule 1). The share divides the headline by the frame-time spend of
// the workspace's runs (./lib/frame-time-spend.ts), so both sides count a
// frame by the time it ran.
//
// The parts (detectors 2, 3, and 5) and the estimate (detector 4) sum the
// stored savings of the open and applied findings of their kinds whose window
// overlaps the period. Each stays beside the headline and out of its sum
// (rules 2 and 3). The status filter is the claims reader's, so a dismissed
// finding counts in no figure here.
import {
  countClaims,
  dayBounds,
  readUnproductiveClaims,
  type UnproductiveClaim,
} from "@oxagen/billing";
import { schema, withTenantDb } from "@oxagen/database";
import { type CapabilityHandler, HandlerError } from "@oxagen/oxagen";
import {
  spendUnproductive,
  type SpendUnproductiveOutput,
  UNPRODUCTIVE_ESTIMATE,
  UNPRODUCTIVE_PARTS,
} from "@oxagen/oxagen/contracts/spend.unproductive";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import {
  type FrameTimeSpendResult,
  frameTimeSpendDeps,
  readFrameTimeSpend,
} from "./lib/frame-time-spend";

type Scope = { orgId: string; workspaceId: string };
type Window = { start: Date; end: Date };

/** The open and applied findings of one kind and currency whose window overlaps the period. */
export type KindSaving = {
  kind: string;
  currency: string;
  micros: bigint;
  findings: number;
};

export type UnproductiveSpendDeps = {
  readClaims: (scope: Scope, window: Window) => Promise<UnproductiveClaim[]>;
  /** The frame-time spend of every run in the workspace. */
  readSpend: (scope: Scope, window: Window) => Promise<FrameTimeSpendResult>;
  readKindSavings: (
    scope: Scope,
    window: Window,
    kinds: readonly string[],
  ) => Promise<KindSaving[]>;
};

const PART_KINDS: readonly string[] = UNPRODUCTIVE_PARTS.flatMap(
  (p) => p.kinds,
);
const ESTIMATE_KINDS: readonly string[] = UNPRODUCTIVE_ESTIMATE.kinds;

async function readClaims(
  scope: Scope,
  window: Window,
): Promise<UnproductiveClaim[]> {
  return withTenantDb((tx) => readUnproductiveClaims(tx, scope, window));
}

function readSpend(scope: Scope, window: Window): Promise<FrameTimeSpendResult> {
  return readFrameTimeSpend(frameTimeSpendDeps, scope, window, null);
}

async function readKindSavings(
  scope: Scope,
  window: Window,
  kinds: readonly string[],
): Promise<KindSaving[]> {
  const findings = schema.findings;
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        kind: findings.kind,
        currency: findings.currency,
        micros: sql<string>`sum(${findings.estimatedSavingMicros})::text`,
        findings: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(findings)
      .where(
        and(
          eq(findings.orgId, scope.orgId),
          eq(findings.workspaceId, scope.workspaceId),
          inArray(findings.status, ["open", "applied"]),
          inArray(findings.kind, [...kinds]),
          lt(findings.windowStart, window.end),
          gt(findings.windowEnd, window.start),
        ),
      )
      .groupBy(findings.kind, findings.currency),
  );
  return rows.map((r) => ({
    kind: r.kind,
    currency: r.currency,
    micros: BigInt(r.micros),
    findings: r.findings,
  }));
}

/** A ratio of two micros amounts, capped at 1; null when the whole is not positive. */
function ratio(part: bigint, whole: bigint): number | null {
  if (whole <= 0n) return null;
  return Math.min(1, Number(part) / Number(whole));
}

/**
 * The workspace's frame-time spend in `currency`; null when nothing was
 * priced, when any of it is in another currency, or when a crossing run was
 * left unpriced.
 */
export function spendIn(
  spend: FrameTimeSpendResult,
  currency: string,
): bigint | null {
  if (spend.partial.size > 0 || spend.rows.length === 0) return null;
  let micros = 0n;
  for (const row of spend.rows) {
    if (row.currency !== currency) return null;
    micros += row.micros;
  }
  return micros;
}

export function createUnproductiveSpendHandler(
  deps: UnproductiveSpendDeps,
): CapabilityHandler<typeof spendUnproductive> {
  return async (input, ctx): Promise<SpendUnproductiveOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const { from, to } = input.period;
    const window = { start: dayBounds(from).start, end: dayBounds(to).next };

    const [claims, savings, spend] = await Promise.all([
      deps.readClaims(scope, window),
      deps.readKindSavings(scope, window, [...PART_KINDS, ...ESTIMATE_KINDS]),
      deps.readSpend(scope, window),
    ]);
    const currencies = [
      ...new Set([
        ...claims.map((c) => c.currency),
        ...savings.map((s) => s.currency),
      ]),
    ].sort();
    if (currencies.length > 1) {
      throw new HandlerError({
        code: "conflict",
        reason: "unproductive_mixed_currency",
        message: `The period holds unproductive spend priced in ${currencies.join(" and in ")}. Each figure sums one currency, so none was built.`,
      });
    }
    const currency = currencies[0] ?? "USD";
    const money = (micros: bigint) => ({ micros: micros.toString(), currency });
    const figure = (kinds: readonly string[]) => {
      let micros = 0n;
      let findings = 0;
      for (const s of savings) {
        if (!kinds.includes(s.kind)) continue;
        micros += s.micros;
        findings += s.findings;
      }
      return { saving: money(micros), findings };
    };

    const headline = countClaims(claims).totalMicros;
    const whole = spendIn(spend, currency);
    return {
      period: { from, to },
      unproductive: money(headline),
      spend: whole === null ? null : money(whole),
      share: whole === null ? null : ratio(headline, whole),
      parts: UNPRODUCTIVE_PARTS.map((p) => ({
        detector: p.detector,
        ...figure(p.kinds),
      })),
      estimate: figure(UNPRODUCTIVE_ESTIMATE.kinds),
    };
  };
}

export const spendUnproductiveHandler = createUnproductiveSpendHandler({
  readClaims,
  readSpend,
  readKindSavings,
});
