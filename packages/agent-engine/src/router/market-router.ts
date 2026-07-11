/**
 * The Verified-Outcome Market Router — PURE decision core (no I/O).
 *
 * The deterministic {@link ./model-router.ts} routes by a hand-coded heuristic:
 * "this text looks like auth work → precise tier". The market router routes by
 * EVIDENCE instead: for a given task class, it looks at how each model has
 * ACTUALLY performed on Oxagen's own history — verified-success rate and observed
 * dollar cost — and treats the subtask like an order routed to the cheapest venue
 * that clears a verified-success threshold. If no model has enough proven
 * successes to clear the bar, it falls back to the deterministic router, so the
 * worst case is exactly today's behavior.
 *
 * This module is I/O-free on purpose: the engine (`@oxagen/agent-engine`) has no
 * ClickHouse access (the BYOK CLI runs it offline), so the observed stats are
 * PRE-FETCHED by a server-side caller and injected as {@link RoutingStatRow}[].
 * `deriveTaskClass` and `decideMarketRoute` are the two pure primitives the
 * engine, the `preview_routing_decision` capability, and the tests all share.
 */
import type { ModelTier } from "../types";
import {
  routeModel,
  tierForSlug,
  DESIGN_SIGNALS,
  TRIVIAL_SIGNALS,
  type RouteDecision,
  type TaskSignals,
} from "./model-router";

// ── Policy ───────────────────────────────────────────────────────────────────

/** How the market router behaves. `off` is the default — today's routing, unchanged. */
export type RoutingMode =
  /** Market routing disabled — the deterministic router decides (today's behavior). */
  | "off"
  /** Compute the market decision and record it, but keep today's routing. Learn without risk. */
  | "shadow"
  /** Use the market decision to pick the worker model, and escalate tiers on judge rejection. */
  | "enforce";

/**
 * The tunables that govern a market decision. Every field has a safe default so a
 * partially-specified policy (e.g. from a preview override) still resolves.
 */
export interface MarketRoutingPolicy {
  mode: RoutingMode;
  /**
   * Minimum observed verified-success RATE (0..1) a model must hit on a task
   * class to be eligible to serve it. Higher = more conservative. Default 0.95.
   */
  successThreshold: number;
  /**
   * Minimum observed sample count a model needs on a task class before its
   * verified rate is trusted (guards against a lucky 1/1). Default 20.
   */
  minSamples: number;
  /** How many days of history the stats are computed over. Default 30. */
  windowDays: number;
  /**
   * When the completeness judge rejects a revision round, escalate the worker one
   * tier (fast→balanced→precise) for the next round. Default true.
   */
  escalateOnRejection: boolean;
}

/** Field defaults for a market routing policy — the single source of truth for them. */
export const DEFAULT_SUCCESS_THRESHOLD = 0.95;
export const DEFAULT_MIN_SAMPLES = 20;
export const DEFAULT_WINDOW_DAYS = 30;

/** The off-by-default policy. Every surface resolves to this when nothing is configured. */
export const ROUTING_POLICY_OFF: MarketRoutingPolicy = {
  mode: "off",
  successThreshold: DEFAULT_SUCCESS_THRESHOLD,
  minSamples: DEFAULT_MIN_SAMPLES,
  windowDays: DEFAULT_WINDOW_DAYS,
  escalateOnRejection: true,
};

/**
 * Fill a partial policy with defaults — used by preview overrides and by policy
 * resolution so a caller can pass just `{ mode: "shadow" }` and get a whole policy.
 */
export function normalizeRoutingPolicy(
  partial: Partial<MarketRoutingPolicy> | null | undefined,
): MarketRoutingPolicy {
  return {
    mode: partial?.mode ?? ROUTING_POLICY_OFF.mode,
    successThreshold:
      partial?.successThreshold ?? ROUTING_POLICY_OFF.successThreshold,
    minSamples: partial?.minSamples ?? ROUTING_POLICY_OFF.minSamples,
    windowDays: partial?.windowDays ?? ROUTING_POLICY_OFF.windowDays,
    escalateOnRejection:
      partial?.escalateOnRejection ?? ROUTING_POLICY_OFF.escalateOnRejection,
  };
}

// ── Stats (the Pareto-curve read) ──────────────────────────────────────────────

/**
 * One (task_class, model) row of observed outcomes — the shape returned by
 * `readRoutingStats` in `@oxagen/telemetry`. The engine never computes these; a
 * server caller injects a snapshot. Cost is carried in micro-USD (1 USD = 1e6) to
 * match the metering pipe (token_usage.cost_usd_micros).
 */
export interface RoutingStatRow {
  taskClass: string;
  model: string;
  /** The tier the model was serving under, for display. */
  tier: string;
  /** Number of recorded outcomes for this (class, model) in the window. */
  samples: number;
  /** How many of those outcomes were verified successes. */
  verifiedCount: number;
  /** verifiedCount / samples, in [0,1]. */
  verifiedRate: number;
  /** Mean observed provider cost per outcome, in micro-USD. */
  avgCostUsdMicros: number;
  /** Mean observed wall-clock latency per outcome, in ms. */
  avgLatencyMs: number;
  /** ISO timestamp of the most recent outcome in the window. */
  lastSeen: string;
}

// ── Decision ───────────────────────────────────────────────────────────────────

/** One model weighed for a task class, with why it was (or wasn't) eligible. */
export interface MarketRouteCandidate {
  model: string;
  verifiedRate: number;
  samples: number;
  avgCostUsdMicros: number;
  /** True when it has enough samples AND clears the success threshold. */
  eligible: boolean;
  /** Human-readable reason for eligibility/ineligibility — the audit trail. */
  reason: string;
}

/** Where a route came from — a real market clearing, or the deterministic fallback. */
export type MarketRouteSource = "market" | "deterministic-fallback";

/**
 * A market route decision. Extends the deterministic {@link RouteDecision}
 * (tier/model/rationale) with the full audit trail: which model won, why, the
 * candidates it beat, and the policy snapshot it cleared against.
 */
export interface MarketRouteDecision extends RouteDecision {
  source: MarketRouteSource;
  taskClass: string;
  /** Every candidate considered, cheapest-first — always populated as the audit trail. */
  candidates: MarketRouteCandidate[];
  /** The policy the decision was made under (echoed for reproducibility). */
  policySnapshot: MarketRoutingPolicy;
}

export interface DecideMarketRouteArgs {
  /** The task's structural signals — used only for the deterministic fallback. */
  signals: TaskSignals;
  /** The task class derived from those signals (see {@link deriveTaskClass}). */
  taskClass: string;
  /** The observed stats snapshot (all task classes — filtered here). */
  stats: RoutingStatRow[];
  policy: MarketRoutingPolicy;
  /** A manual model pin. Always wins, preserving today's pin semantics. */
  override?: string;
}

/**
 * Decide the worker model for a task class from observed outcomes.
 *
 * Precedence:
 *   1. A manual `override` pin always wins (today's `--model` semantics).
 *   2. Among stats rows for this class, a model is ELIGIBLE when it has
 *      `>= minSamples` samples AND `>= successThreshold` verified rate. Choose the
 *      CHEAPEST eligible by observed cost; tie-break higher verified rate, then
 *      lower latency.
 *   3. If none are eligible, fall back to the deterministic `routeModel()`.
 *
 * The full `candidates` array (cheapest-first) is ALWAYS returned — it is the
 * audit trail that explains the decision, whether market or fallback.
 */
export function decideMarketRoute(
  args: DecideMarketRouteArgs,
): MarketRouteDecision {
  const { signals, taskClass, stats, policy, override } = args;

  const rows = stats.filter((r) => r.taskClass === taskClass);
  // Candidates, cheapest-first, each annotated with its eligibility reason.
  const candidates: MarketRouteCandidate[] = rows
    .map((r): MarketRouteCandidate => {
      const enoughSamples = r.samples >= policy.minSamples;
      const clears = r.verifiedRate >= policy.successThreshold;
      const eligible = enoughSamples && clears;
      const pct = (r.verifiedRate * 100).toFixed(1);
      const barPct = (policy.successThreshold * 100).toFixed(0);
      const reason = !enoughSamples
        ? `insufficient samples (${r.samples} < ${policy.minSamples} needed)`
        : !clears
          ? `verified ${pct}% < ${barPct}% bar`
          : `clears bar — verified ${pct}% over ${r.samples} samples`;
      return {
        model: r.model,
        verifiedRate: r.verifiedRate,
        samples: r.samples,
        avgCostUsdMicros: r.avgCostUsdMicros,
        eligible,
        reason,
      };
    })
    .sort((a, b) => a.avgCostUsdMicros - b.avgCostUsdMicros);

  // 1. Manual pin — bypass the market entirely but still return the audit trail.
  if (override) {
    return {
      tier: tierForSlug(override),
      model: override,
      rationale: "pinned model — market routing bypassed",
      source: "deterministic-fallback",
      taskClass,
      candidates,
      policySnapshot: policy,
    };
  }

  // 2. Cheapest eligible clears the venue. Tie-break: higher verified rate, then
  //    lower latency (a cost tie between two proven models should prefer the one
  //    that is both more reliable and faster).
  const byModel = new Map(rows.map((r) => [r.model, r]));
  const eligible = candidates.filter((c) => c.eligible);
  if (eligible.length > 0) {
    const winner = [...eligible].sort((a, b) => {
      if (a.avgCostUsdMicros !== b.avgCostUsdMicros)
        return a.avgCostUsdMicros - b.avgCostUsdMicros;
      if (b.verifiedRate !== a.verifiedRate)
        return b.verifiedRate - a.verifiedRate;
      const la = byModel.get(a.model)?.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      const lb = byModel.get(b.model)?.avgLatencyMs ?? Number.POSITIVE_INFINITY;
      return la - lb;
    })[0]!;
    const dollars = (winner.avgCostUsdMicros / 1_000_000).toFixed(4);
    return {
      tier: tierForSlug(winner.model),
      model: winner.model,
      rationale:
        `market route — cheapest model clearing ${(policy.successThreshold * 100).toFixed(0)}% verified ` +
        `(${(winner.verifiedRate * 100).toFixed(1)}% over ${winner.samples} samples, ~$${dollars}/outcome)`,
      source: "market",
      taskClass,
      candidates,
      policySnapshot: policy,
    };
  }

  // 3. No proven venue — defer to the deterministic router (today's behavior).
  const fallback = routeModel(signals);
  return {
    tier: fallback.tier,
    model: fallback.model,
    rationale: `no model cleared the verified-success bar for "${taskClass}" — ${fallback.rationale}`,
    source: "deterministic-fallback",
    taskClass,
    candidates,
    policySnapshot: policy,
  };
}

/** A per-task-class summary of what the market currently clears — the Pareto read's headline. */
export interface RoutingClassSummary {
  taskClass: string;
  /** The cheapest model clearing the bar for this class, or null when none does. */
  cheapestEligibleModel: string | null;
  /** The winner's verified rate, or null when none is eligible. */
  verifiedRate: number | null;
  /** The winner's average observed cost (micro-USD), or null when none is eligible. */
  avgCostUsdMicros: number | null;
  /** How many (class, model) groups exist for this class. */
  candidateCount: number;
  /** How many of them are eligible under the policy. */
  eligibleCount: number;
}

/**
 * Summarize a stats snapshot into one row per task class: the cheapest model
 * currently clearing the verified-success bar (or null when none does), plus
 * candidate/eligible counts. Uses the SAME eligibility test as
 * {@link decideMarketRoute}, so the summary and the live decision never disagree.
 * Ordered by task class for a stable render.
 */
export function summarizeRoutingStats(
  stats: RoutingStatRow[],
  policy: MarketRoutingPolicy,
): RoutingClassSummary[] {
  const byClass = new Map<string, RoutingStatRow[]>();
  for (const r of stats) {
    const arr = byClass.get(r.taskClass);
    if (arr) arr.push(r);
    else byClass.set(r.taskClass, [r]);
  }

  const summaries: RoutingClassSummary[] = [];
  for (const [taskClass, rows] of byClass) {
    const eligible = rows.filter(
      (r) =>
        r.samples >= policy.minSamples &&
        r.verifiedRate >= policy.successThreshold,
    );
    const cheapest =
      eligible.length > 0
        ? [...eligible].sort(
            (a, b) => a.avgCostUsdMicros - b.avgCostUsdMicros,
          )[0]!
        : null;
    summaries.push({
      taskClass,
      cheapestEligibleModel: cheapest?.model ?? null,
      verifiedRate: cheapest?.verifiedRate ?? null,
      avgCostUsdMicros: cheapest?.avgCostUsdMicros ?? null,
      candidateCount: rows.length,
      eligibleCount: eligible.length,
    });
  }
  return summaries.sort((a, b) => a.taskClass.localeCompare(b.taskClass));
}

/**
 * Escalate a tier one step: fast → balanced → precise. `precise` is the ceiling
 * and stays `precise`. Used to spend up on the next revision round when the judge
 * rejects the current one.
 */
export function escalateTier(tier: ModelTier): ModelTier {
  switch (tier) {
    case "fast":
      return "balanced";
    case "balanced":
      return "precise";
    case "precise":
      return "precise";
  }
}

// ── Task-class derivation ──────────────────────────────────────────────────────

/**
 * The high-stakes domain buckets, in priority order. This REFINES the single
 * `PRECISE_DOMAINS` regex from model-router into named labels so a task class is
 * meaningful ("auth/single" not just "precise"). A prompt matching several picks
 * the first. Kept deliberately coarse to keep task-class cardinality low — sparse
 * classes never accumulate enough samples to clear the bar.
 */
const TASK_CLASS_DOMAINS: ReadonlyArray<{ label: string; re: RegExp }> = [
  {
    label: "auth",
    re: /\b(auth|authn|authz|login|session|password|credential|oauth|saml|sso)\b/i,
  },
  {
    label: "billing",
    re: /\b(billing|payment|invoice|stripe|charge|refund|meter|pricing|rate card)\b/i,
  },
  {
    label: "security",
    re: /\b(security|crypto|encrypt|decrypt|secret|rls|tenant)\b/i,
  },
  {
    label: "migration",
    re: /\b(migration|migrate|backfill|schema change|ddl)\b/i,
  },
  {
    label: "data-model",
    re: /\b(data model|schema|database|postgres|clickhouse|neo4j|graph)\b/i,
  },
  {
    label: "architecture",
    re: /\b(architecture|architect|rearchitect|redesign|storage boundary)\b/i,
  },
  {
    label: "infra",
    re: /\b(production incident|outage|deploy|ci|pipeline|infra|race condition|deadlock)\b/i,
  },
];

/** Coarse breadth bucket from file count / cross-package flag. */
function breadthBucket(files: number, crossPackage: boolean): string {
  if (files >= 8) return "wide";
  if (crossPackage) return "cross-package";
  if (files >= 4) return "multi";
  if (files >= 2) return "small";
  return "single";
}

/**
 * Derive a stable, low-cardinality task-class key from the SAME signals the
 * router sees. Shape: `<primary>/<breadth>` where `primary` is a high-stakes
 * domain label (auth/billing/…) when one matches, else the work kind
 * (trivial/design/general), and `breadth` is a coarse file-count bucket. Pure and
 * deterministic — the same prompt always yields the same class, so outcomes
 * aggregate meaningfully in ClickHouse.
 */
export function deriveTaskClass(signals: TaskSignals): string {
  const text = signals.text ?? "";
  const files = signals.fileCount ?? 0;
  const crossPackage = signals.crossPackage ?? false;

  let primary = "general";
  const domain = TASK_CLASS_DOMAINS.find((d) => d.re.test(text));
  if (domain) {
    primary = domain.label;
  } else if (TRIVIAL_SIGNALS.test(text) && !DESIGN_SIGNALS.test(text)) {
    primary = "trivial";
  } else if (DESIGN_SIGNALS.test(text)) {
    primary = "design";
  }

  return `${primary}/${breadthBucket(files, crossPackage)}`;
}

// ── Governance resolution ──────────────────────────────────────────────────────

/** Which scope supplied the effective routing policy. */
export type RoutingPolicySource = "workspace" | "org" | "default";

export interface ResolvedRoutingPolicy {
  policy: MarketRoutingPolicy;
  source: RoutingPolicySource;
}

/**
 * Resolve the effective routing policy from optional org- and workspace-level
 * governance rows. Most-specific wins: a workspace policy overrides an org
 * policy, which overrides the OFF default. PURE (mirrors the shape of
 * `resolveEffectiveTurnBudget`); the persistence layer loads the rows and the
 * engine consumes only the resolved policy.
 *
 * v1 uses a simple override precedence rather than the budget's default/ceiling
 * merge — routing has no per-user layer to clamp, and the governance property
 * that matters (only an admin can turn the market on; off by default) holds
 * under plain override. A default/ceiling merge is a future refinement.
 */
export function resolveEffectiveRoutingPolicy(
  org: MarketRoutingPolicy | null | undefined,
  workspace: MarketRoutingPolicy | null | undefined,
): ResolvedRoutingPolicy {
  if (workspace) return { policy: workspace, source: "workspace" };
  if (org) return { policy: org, source: "org" };
  return { policy: ROUTING_POLICY_OFF, source: "default" };
}
