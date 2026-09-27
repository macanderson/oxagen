/**
 * Model class replay (detector 4, ADR-208): the plan that reruns a sample of
 * a model class fit finding's runs on the smaller class, and the gate a
 * replay starts through. A replay spends, so it starts only on an approval
 * from the team that owns the runs, and only when that approval showed the
 * plan's estimated cost. The replay turns the finding's estimate into a
 * measurement.
 *
 * Both halves are pure. The caller passes the finding, the run records it
 * cites, and the owners, and stores the plan and the approval. The gate
 * returns the only value a dispatcher accepts.
 */
import { createHash } from "node:crypto";
import type { RunTotalsRecord } from "../cost-rollup";
import type { PriceBook } from "../price-book";
import { inCodeListBook, lighterModel, measureRun } from "./model-class-fit";
import type { FindingDraft } from "./shared";

/** Runs one replay reruns at most. */
export const REPLAY_SAMPLE_MAX = 5;

/** One sampled run, as the replay reruns it. */
export interface ReplayRun {
  /** The run's public id. */
  runId: string;
  /** Each model the run used and the model the replay runs it on; the same model when it has no smaller class. */
  models: { from: string; to: string }[];
  /** What the run cost as measured, in micro-units. */
  measuredMicros: bigint;
  /** What the replay is estimated to cost: the run repriced at the smaller class. */
  estimatedMicros: bigint;
}

export interface ReplayPlan {
  kind: "model_class_fit";
  /** The finding the plan replays. */
  fingerprint: string;
  subject: string;
  currency: string;
  runs: ReplayRun[];
  /** The sum of the sampled runs' estimates, which the approval must show. */
  estimatedMicros: bigint;
  plannedAt: Date;
  /** SHA-256 over every field above, so an approval binds to this plan alone. */
  digest: string;
}

/** A person's approval of one plan, with the cost it showed them. */
export interface ReplayApproval {
  planDigest: string;
  /** The estimated cost the approval showed, in micro-units. */
  shownMicros: bigint;
  shownCurrency: string;
  /** The key of the person who approved. */
  approvedBy: string;
  approvedAt: Date;
}

declare const approvedByOwner: unique symbol;

/** A replay the gate let start. Only {@link startReplay} returns one. */
export type ReplayStart = {
  readonly plan: ReplayPlan;
  readonly approval: ReplayApproval;
  readonly [approvedByOwner]: true;
};

/** Why the gate refused a replay. */
export type ReplayRefusal =
  /** Nothing approved the plan. */
  | "no_approval"
  /** The plan changed after it was digested. */
  | "plan_changed"
  /** The approval names another plan. */
  | "other_plan"
  /** The approval showed a cost other than the plan's estimate. */
  | "cost_not_shown"
  /** The approver does not own the runs. */
  | "not_an_owner"
  /** The approval is older than the plan. */
  | "approved_before_plan";

/** The digest of a plan's fields, with amounts as decimal strings. */
export function replayPlanDigest(plan: Omit<ReplayPlan, "digest">): string {
  const canonical = JSON.stringify([
    plan.kind,
    plan.fingerprint,
    plan.subject,
    plan.currency,
    plan.runs.map((r) => [
      r.runId,
      r.models.map((m) => [m.from, m.to]),
      r.measuredMicros.toString(),
      r.estimatedMicros.toString(),
    ]),
    plan.estimatedMicros.toString(),
    plan.plannedAt.toISOString(),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * `count` items spread over `n`: the middle of each of `count` equal slices,
 * so the sample spans the smallest runs and the largest. Every index when
 * `n` is no more than `count`.
 */
function spread(n: number, count: number): number[] {
  if (n <= count) return Array.from({ length: n }, (_, i) => i);
  return Array.from({ length: count }, (_, i) =>
    Math.floor(((2 * i + 1) * n) / (2 * count)),
  );
}

/**
 * The replay of a model class fit finding: a sample of its cited runs, each
 * with the model it reruns on and its estimated cost there. A run is left
 * out when it is absent from `runs`, has no model with a smaller class, or
 * the book cannot price it, since the approval must show a cost for every
 * run it starts. Null when the finding is another kind or no run is left.
 */
export function planReplay(args: {
  finding: Pick<
    FindingDraft,
    "kind" | "fingerprint" | "subject" | "currency" | "citedRuns"
  >;
  runs: ReadonlyMap<string, RunTotalsRecord>;
  now: Date;
  book?: PriceBook;
  sampleMax?: number;
}): ReplayPlan | null {
  const { finding } = args;
  if (finding.kind !== "model_class_fit") return null;
  const book = args.book ?? inCodeListBook();
  const priced: ReplayRun[] = [];
  for (const runId of new Set(finding.citedRuns)) {
    const run = args.runs.get(runId);
    if (run === undefined) continue;
    const models = run.breakdown.models.map((m) => ({
      from: m.model,
      to: lighterModel(m) ?? m.model,
    }));
    if (models.every((m) => m.from === m.to)) continue;
    const { micros } = measureRun(book, run);
    if (micros === null) continue;
    priced.push({
      runId,
      models,
      measuredMicros: micros.measured,
      estimatedMicros: micros.counterfactual,
    });
  }
  if (priced.length === 0) return null;
  priced.sort((a, b) =>
    a.measuredMicros !== b.measuredMicros
      ? a.measuredMicros < b.measuredMicros
        ? -1
        : 1
      : a.runId < b.runId
        ? -1
        : 1,
  );
  const sample = spread(
    priced.length,
    Math.max(1, args.sampleMax ?? REPLAY_SAMPLE_MAX),
  ).map((i) => priced[i]!);
  const plan: Omit<ReplayPlan, "digest"> = {
    kind: "model_class_fit",
    fingerprint: finding.fingerprint,
    subject: finding.subject,
    currency: finding.currency,
    runs: sample,
    estimatedMicros: sample.reduce((sum, r) => sum + r.estimatedMicros, 0n),
    plannedAt: args.now,
  };
  return { ...plan, digest: replayPlanDigest(plan) };
}

/**
 * The gate a replay starts through. It refuses unless an owner of the runs
 * approved this plan, after it was made, with the plan's estimated cost in
 * front of them. The dispatcher that reruns the runs takes only the value
 * this returns.
 */
export function startReplay(
  plan: ReplayPlan,
  approval: ReplayApproval | null,
  owners: ReadonlySet<string>,
): { ok: true; start: ReplayStart } | { ok: false; refusal: ReplayRefusal } {
  if (approval === null) return { ok: false, refusal: "no_approval" };
  const { digest, ...fields } = plan;
  if (replayPlanDigest(fields) !== digest)
    return { ok: false, refusal: "plan_changed" };
  if (approval.planDigest !== digest)
    return { ok: false, refusal: "other_plan" };
  if (
    approval.shownMicros !== plan.estimatedMicros ||
    approval.shownCurrency !== plan.currency
  )
    return { ok: false, refusal: "cost_not_shown" };
  if (!owners.has(approval.approvedBy))
    return { ok: false, refusal: "not_an_owner" };
  if (approval.approvedAt.getTime() < plan.plannedAt.getTime())
    return { ok: false, refusal: "approved_before_plan" };
  return { ok: true, start: { plan, approval } as ReplayStart };
}
