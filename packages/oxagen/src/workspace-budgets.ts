/**
 * The three things a workspace's own model calls spend on, each with its own
 * daily budget (#5426). Billing is pass-through, so the cap is the
 * customer's control, per workspace, and one lane never spends another's.
 *
 * - `run_enrichment`: the names and accounts the sweep writes for runs.
 * - `assistant`: Stella chat in the app, ad hoc use from the flyout.
 * - `work`: work orders: triage, briefs, and sending.
 *
 * The budgets live in `workspace.workspaces.settings.dailyBudgetUsd`, beside
 * `runEnrichmentEnabled`, as US dollars per UTC day. A lane with no value
 * has no limit. The counter the gates read is `billing.spend_counters`,
 * which carries the lane the usage row's `capability_name` maps to
 * (`spendLaneOf` in @oxagen/billing).
 */
export const SPEND_LANES = ["run_enrichment", "assistant", "work"] as const;

export type SpendLane = (typeof SPEND_LANES)[number];

/** The settings key of each lane's daily budget. */
export const SPEND_LANE_KEYS = {
  run_enrichment: "runEnrichment",
  assistant: "assistant",
  work: "work",
} as const satisfies Record<SpendLane, string>;

export type SpendLaneKey = (typeof SPEND_LANE_KEYS)[SpendLane];

/** Each lane's daily budget in US dollars, or null for no limit. */
export type DailyBudgetUsd = Record<SpendLaneKey, number | null>;

export const NO_DAILY_BUDGET: DailyBudgetUsd = {
  runEnrichment: null,
  assistant: null,
  work: null,
};

/** What a person reads when a lane is named. */
export const SPEND_LANE_LABELS: Record<SpendLane, string> = {
  run_enrichment: "run enrichment",
  assistant: "Stella chat",
  work: "work orders",
};

function budgetValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

/**
 * The daily budgets a workspace's settings hold. A missing bag, a malformed
 * one, or a malformed value reads as no limit, the way `runEnrichmentEnabled`
 * reads a malformed value as on: a setting that cannot be read never refuses
 * a call.
 */
export function dailyBudgetUsdOf(settings: unknown): DailyBudgetUsd {
  if (
    typeof settings !== "object" ||
    settings === null ||
    Array.isArray(settings)
  )
    return { ...NO_DAILY_BUDGET };
  const bag = (settings as Record<string, unknown>).dailyBudgetUsd;
  if (typeof bag !== "object" || bag === null || Array.isArray(bag))
    return { ...NO_DAILY_BUDGET };
  const values = bag as Record<string, unknown>;
  return {
    runEnrichment: budgetValue(values.runEnrichment),
    assistant: budgetValue(values.assistant),
    work: budgetValue(values.work),
  };
}

/** The daily budget of one lane, in US dollars, or null for no limit. */
export function laneBudgetUsd(settings: unknown, lane: SpendLane): number | null {
  return dailyBudgetUsdOf(settings)[SPEND_LANE_KEYS[lane]];
}
