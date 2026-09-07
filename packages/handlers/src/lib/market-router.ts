/**
 * The Verified-Outcome Market Router — PURE decision core (no I/O).
 *
 * Model routing is BYOK governance: the platform decides WHICH model a tenant's
 * spend is routed to, from evidence the platform already meters (verified
 * outcomes and observed cost per task class), under an admin-set policy. It is
 * not an execution concern, so it survived the ADR-043 runtime excision — but
 * its former home (`@oxagen/agent-engine`) did not. The minimal pure core the
 * `router.*` governance capabilities need therefore lives here, next to the
 * handlers that are its only remaining consumers.
 *
 * I/O-free on purpose: the observed stats are read by the caller (ClickHouse via
 * `@oxagen/telemetry`) and injected as {@link RoutingStatRow}[]. The policy rows
 * are read by `./routing-policy.ts`. This module only decides.
 *
 * Tier → concrete gateway slug resolution goes through `@oxagen/ai`'s
 * `tierModelId()` so the vendor-neutral white-labelled tiers stay the single
 * source of truth for model ids; no slug is hard-coded here.
 */
import { tierModelId, type OxagenTier } from "@oxagen/ai";
import type { RoutingStatRow } from "@oxagen/telemetry";
import type {
  RoutingMode,
  RoutingPolicyShape,
} from "@oxagen/oxagen/contracts/router-schema";

export type { RoutingMode, RoutingStatRow };

/**
 * The tunables that govern a market decision — structurally the contract's
 * `routingPolicySchema`, so a policy resolved here serializes straight into a
 * capability output without a mapping step.
 */
export type MarketRoutingPolicy = RoutingPolicyShape;

// ── Policy defaults ──────────────────────────────────────────────────────────

/** Minimum observed verified-success rate a model must clear to serve a class. */
export const DEFAULT_SUCCESS_THRESHOLD = 0.95;
/** Minimum sample count before a model's verified rate is trusted. */
export const DEFAULT_MIN_SAMPLES = 20;
/** Trailing window, in days, the stats are computed over. */
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

// ── Governance resolution ────────────────────────────────────────────────────

/** Which scope supplied the effective routing policy. */
export type RoutingPolicySource = "workspace" | "org" | "default";

export interface ResolvedRoutingPolicy {
  policy: MarketRoutingPolicy;
  source: RoutingPolicySource;
}

/**
 * Resolve the effective routing policy from optional org- and workspace-level
 * governance rows. Most-specific wins: a workspace policy overrides an org
 * policy, which overrides the OFF default. PURE — the persistence layer loads
 * the rows (see `./routing-policy.ts`) and every reader consumes only this.
 */
export function resolveEffectiveRoutingPolicy(
  org: MarketRoutingPolicy | null | undefined,
  workspace: MarketRoutingPolicy | null | undefined,
): ResolvedRoutingPolicy {
  if (workspace) return { policy: workspace, source: "workspace" };
  if (org) return { policy: org, source: "org" };
  return { policy: ROUTING_POLICY_OFF, source: "default" };
}

// ── Deterministic fallback ───────────────────────────────────────────────────

/** Cheap structural signals about a task, gathered without calling a model. */
export interface TaskSignals {
  /** The task description / prompt. */
  text: string;
  /** Number of files the task is expected to touch, if known. */
  fileCount?: number;
  /** Whether the task crosses package boundaries. */
  crossPackage?: boolean;
}

export interface RouteDecision {
  tier: OxagenTier;
  model: string;
  /** One-line, human-readable reason — the audit trail's headline. */
  rationale: string;
}

// Domains that demand the precise tier regardless of size: a wrong call here is
// expensive (security / data correctness), so we never under-spend on them.
// Bare "token" is deliberately excluded — it collides with lexer/parser "tokens".
const PRECISE_DOMAINS =
  /\b(auth|authn|authz|login|session|password|secret|credential|oauth|saml|sso|billing|payment|invoice|stripe|charge|refund|security|crypto|encrypt|decrypt|rls|tenant|migration|schema change|architecture|architect|data model|storage boundary|production incident|outage|race condition)\b/i;

/** Words that signal genuine design / non-trivial reasoning → at least balanced. */
const DESIGN_SIGNALS =
  /\b(design|refactor|redesign|rearchitect|debug|investigate|root[- ]cause|why|optimi[sz]e|performance|concurren|async|deadlock|integrate|cross[- ]package|end[- ]to[- ]end|e2e|new (feature|capability|endpoint|tool|service)|implement)\b/i;

/** Words that signal trivial, mechanical work → the fast tier is plenty. */
const TRIVIAL_SIGNALS =
  /\b(rename|format|typo|comment|lint|prettier|reword|copy[- ]?edit|bump|sort imports|add a? ?(log|console)|tweak|adjust spacing|fix indentation|update (the )?(version|readme|changelog)|one[- ]liner)\b/i;

/**
 * Choose the cheapest tier that can do the job from structural signals alone.
 * Deterministic and free — no LLM call — so it is a safe fallback for a class
 * where the market has not yet proven a venue.
 */
export function classifyTier(signals: TaskSignals): RouteDecision {
  const text = signals.text ?? "";
  const files = signals.fileCount ?? 0;
  const pick = (tier: OxagenTier, rationale: string): RouteDecision => ({
    tier,
    model: tierModelId(tier),
    rationale,
  });

  if (PRECISE_DOMAINS.test(text)) {
    return pick(
      "precise",
      "touches a high-stakes domain (auth/billing/security/migration/architecture)",
    );
  }

  // Breadth dominates: a wide change needs a model that can hold more context.
  if (files >= 8 || (signals.crossPackage && files >= 4)) {
    return pick("precise", `wide blast radius (~${files} files)`);
  }
  if (files > 3 || signals.crossPackage) {
    return pick(
      "balanced",
      signals.crossPackage
        ? "crosses package boundaries"
        : `multi-file (~${files} files)`,
    );
  }

  if (TRIVIAL_SIGNALS.test(text) && !DESIGN_SIGNALS.test(text)) {
    return pick("fast", "mechanical / single-file change");
  }
  if (DESIGN_SIGNALS.test(text)) {
    return pick("balanced", "non-trivial logic or debugging");
  }
  if (text.trim().length < 60 && files <= 1) {
    return pick("fast", "small, well-scoped ask");
  }
  return pick("balanced", "general-purpose default");
}

// Slug fragments that classify an arbitrary gateway model into a tier, across
// vendors. SMALL is checked first so a cheap variant of a frontier family
// (`gpt-5-mini`, `o3-mini`, `gemini-3.5-flash`) is never mislabelled as precise.
const SMALL_MARKER = /\b(mini|nano|flash|lite|small|nemo)\b|\b\d{1,3}b\b/;
const PRECISE_MARKER =
  /\b(opus|codex|pro|large|o1|o3|deepseek-v4|deepseek-r1|magistral-medium)\b/;

/** Best-effort tier label for an arbitrary gateway slug (display only). */
export function tierForSlug(model: string): OxagenTier {
  const family = (model.split("/").pop() ?? model).toLowerCase();
  if (family.startsWith("claude-haiku") || SMALL_MARKER.test(family))
    return "fast";
  if (
    family.startsWith("claude-opus") ||
    family.startsWith("claude-fable") ||
    family.startsWith("claude-mythos") ||
    family.startsWith("gpt-5") ||
    PRECISE_MARKER.test(family)
  )
    return "precise";
  return "balanced";
}

// ── Task-class derivation ────────────────────────────────────────────────────

/**
 * The high-stakes domain buckets, in priority order — named labels so a task
 * class is meaningful ("auth/single", not just "precise"). Deliberately coarse:
 * sparse classes never accumulate enough samples to clear the bar.
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
 * Derive a stable, low-cardinality task-class key from the same signals the
 * router sees: `<primary>/<breadth>`. Pure and deterministic — the same prompt
 * always yields the same class, so outcomes aggregate meaningfully.
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

// ── Decision ─────────────────────────────────────────────────────────────────

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
 * A market route decision: the deterministic {@link RouteDecision} plus the full
 * audit trail — which model won, why, the candidates it beat, and the policy
 * snapshot it cleared against.
 */
export interface MarketRouteDecision extends RouteDecision {
  source: MarketRouteSource;
  taskClass: string;
  /** Every candidate considered, cheapest-first — always populated. */
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
  /** A manual model pin. Always wins. */
  override?: string;
}

/**
 * Decide the worker model for a task class from observed outcomes.
 *
 * Precedence:
 *   1. A manual `override` pin always wins.
 *   2. Among stats rows for this class, a model is ELIGIBLE when it has
 *      `>= minSamples` samples AND `>= successThreshold` verified rate. Choose
 *      the CHEAPEST eligible by observed cost; tie-break higher verified rate,
 *      then lower latency.
 *   3. If none are eligible, fall back to {@link classifyTier}.
 *
 * The full `candidates` array (cheapest-first) is ALWAYS returned — it is the
 * audit trail that explains the decision, market or fallback.
 */
export function decideMarketRoute(
  args: DecideMarketRouteArgs,
): MarketRouteDecision {
  const { signals, taskClass, stats, policy, override } = args;

  const rows = stats.filter((r) => r.taskClass === taskClass);
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
  //    lower latency.
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

  // 3. No proven venue — defer to the deterministic classifier.
  const fallback = classifyTier(signals);
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

/** A per-task-class summary of what the market currently clears. */
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
 * {@link decideMarketRoute}, so the summary and the live decision never
 * disagree. Ordered by task class for a stable render.
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
