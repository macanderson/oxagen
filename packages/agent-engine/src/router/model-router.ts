/**
 * Cost-aware model routing for the agent engine.
 *
 * Turns a task description (plus a few cheap structural signals) into a
 * {@link ModelTier} and a concrete gateway slug, deterministically and without
 * an extra LLM round-trip — encoding the CLAUDE.md operating-model table in code.
 *
 * Dollar costs come from the baked-in rate card in {@link ./rate-card.ts} — the
 * single place model prices live in the engine. This module re-exports the pricing
 * helpers so existing imports keep working, but does not own a second copy.
 *
 * Unlike the CLI version, this module does NOT read `config.model` — that is
 * the caller's responsibility. Pass an `override` string explicitly, or read
 * `OXAGEN_MODEL` from env.
 */
import type { ModelTier, UsageTotals } from "../types";
import { estimateCostUsd, rateFor, formatUsd } from "./rate-card";

// Re-exported so call sites that import pricing from the router keep working.
// The authoritative definitions live in ./rate-card.ts.
export { estimateCostUsd, rateFor, formatUsd };

// Re-export the tier type so consumers can import from this module alone.
export type { ModelTier };

/** A tier's concrete gateway slug, overridable per-env to track gateway drift. */
function tierSlug(tier: ModelTier): string {
  switch (tier) {
    case "fast":
      return process.env["OXAGEN_LLM_FAST"] ?? "anthropic/claude-haiku-4.5";
    case "balanced":
      return process.env["OXAGEN_LLM_BALANCED"] ?? "anthropic/claude-sonnet-5";
    case "precise":
      return process.env["OXAGEN_LLM_PRECISE"] ?? "anthropic/claude-fable-5";
  }
}

export const TIERS: ModelTier[] = ["fast", "balanced", "precise"];

/** Human label for a tier, for the agents screen and `--explain` output. */
export function tierLabel(tier: ModelTier): string {
  return tier === "fast" ? "Haiku" : tier === "balanced" ? "Sonnet" : "Fable";
}

// ── Usage accumulation ───────────────────────────────────────────────────────
// Pricing helpers (rateFor / estimateCostUsd / formatUsd) come from the rate
// card; this only composes them into a running per-turn total.

/** Add a per-call usage into a running total, pricing it on the call's model. */
export function accumulateUsage(
  total: UsageTotals,
  model: string,
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
  },
): UsageTotals {
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    // rate-card's TokenUsage names this `cachedTokens`; callers here (engine
    // step-loop / evaluator / judge results) name it `cachedInputTokens` —
    // map field names at this one seam so the cache discount actually
    // applies instead of silently being dropped by a key mismatch.
    costUsd:
      total.costUsd +
      estimateCostUsd(model, {
        ...usage,
        cachedTokens: usage.cachedInputTokens,
      }),
  };
}

// ── Complexity classifier ────────────────────────────────────────────────────

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
  tier: ModelTier;
  model: string;
  /** One-line, human-readable reason — surfaced by `--explain` and the TUI. */
  rationale: string;
}

// Domains that demand the precise tier regardless of size: a wrong call here is
// expensive (security/data correctness), so we never under-spend on them.
// NOTE: bare "token" is deliberately excluded — it collides with lexer/parser
// "tokens". Auth work is caught by the unambiguous terms below.
// Exported so the market router's `deriveTaskClass` classifies task classes from
// the SAME vocabulary the deterministic tiering uses — one source of truth for
// what counts as a high-stakes domain / design / trivial ask.
export const PRECISE_DOMAINS =
  /\b(auth|authn|authz|login|session|password|secret|credential|oauth|saml|sso|billing|payment|invoice|stripe|charge|refund|security|crypto|encrypt|decrypt|rls|tenant|migration|schema change|architecture|architect|data model|storage boundary|production incident|outage|race condition)\b/i;

// Words that signal genuine design / non-trivial reasoning → at least balanced.
export const DESIGN_SIGNALS =
  /\b(design|refactor|redesign|rearchitect|debug|investigate|root[- ]cause|why|optimi[sz]e|performance|concurren|async|deadlock|integrate|cross[- ]package|end[- ]to[- ]end|e2e|new (feature|capability|endpoint|tool|service)|implement)\b/i;

// Words that signal trivial, mechanical work → fast tier is plenty.
export const TRIVIAL_SIGNALS =
  /\b(rename|format|typo|comment|lint|prettier|reword|copy[- ]?edit|bump|sort imports|add a? ?(log|console)|tweak|adjust spacing|fix indentation|update (the )?(version|readme|changelog)|one[- ]liner)\b/i;

/**
 * Choose the cheapest tier that can do the job. Deterministic and cheap — no LLM
 * call — so it runs on every dispatch without adding latency or token cost.
 *
 * Priority of evidence (most → least decisive):
 *   1. Precise-only domains (auth/billing/security/migration/architecture).
 *   2. Breadth: many files or cross-package work escalates to balanced/precise.
 *   3. Design / debugging language escalates to balanced.
 *   4. Explicitly trivial language pins to fast.
 *   5. Default: balanced — the safe general-purpose tier.
 */
export function classifyTier(signals: TaskSignals): RouteDecision {
  const text = signals.text ?? "";
  const files = signals.fileCount ?? 0;
  const slug = (tier: ModelTier, rationale: string): RouteDecision => ({
    tier,
    model: tierSlug(tier),
    rationale,
  });

  if (PRECISE_DOMAINS.test(text)) {
    return slug(
      "precise",
      "touches a high-stakes domain (auth/billing/security/migration/architecture)",
    );
  }

  // Breadth dominates: a wide change needs a model that can hold more context.
  if (files >= 8 || (signals.crossPackage && files >= 4)) {
    return slug("precise", `wide blast radius (~${files} files)`);
  }
  if (files > 3 || signals.crossPackage) {
    return slug(
      "balanced",
      signals.crossPackage
        ? "crosses package boundaries"
        : `multi-file (~${files} files)`,
    );
  }

  if (TRIVIAL_SIGNALS.test(text) && !DESIGN_SIGNALS.test(text)) {
    return slug("fast", "mechanical / single-file change");
  }

  if (DESIGN_SIGNALS.test(text)) {
    return slug("balanced", "non-trivial logic or debugging");
  }

  // Very short, unqualified asks are usually small lookups/edits.
  if (text.trim().length < 60 && files <= 1) {
    return slug("fast", "small, well-scoped ask");
  }

  return slug("balanced", "general-purpose default");
}

/**
 * Resolve the model for a task, honouring a manual override first.
 *
 * Manual precedence: an explicit slug (`override`), then `OXAGEN_MODEL` env
 * var. If neither is set, auto-route from the task signals.
 *
 * Note: unlike the CLI version, this does NOT read config.model. The caller
 * is responsible for passing a pinned model via `override` if desired.
 */
export function routeModel(
  signals: TaskSignals,
  override?: string,
): RouteDecision {
  const manual = override ?? process.env["OXAGEN_MODEL"];
  if (manual) {
    return {
      tier: tierForSlug(manual),
      model: manual,
      rationale: "pinned model",
    };
  }
  return classifyTier(signals);
}

// Slug fragments that classify an arbitrary gateway model into a tier, across
// vendors (Anthropic, OpenAI, Google, DeepSeek, Mistral). SMALL is checked first
// so a cheap variant of a frontier family (e.g. `gpt-5-mini`, `o3-mini`,
// `gemini-3.5-flash`) is never mislabelled as precise.
const SMALL_MARKER = /\b(mini|nano|flash|lite|small|nemo)\b|\b\d{1,3}b\b/;
const PRECISE_MARKER =
  /\b(opus|codex|pro|large|o1|o3|deepseek-v4|deepseek-r1|magistral-medium)\b/;

/** Best-effort tier label for an arbitrary slug (for display of pinned models). */
export function tierForSlug(model: string): ModelTier {
  const family = (model.split("/").pop() ?? model).toLowerCase();
  // Cheap/small variants win first — every vendor marks them the same way.
  if (family.startsWith("claude-haiku") || SMALL_MARKER.test(family))
    return "fast";
  // Frontier / high-capability families across vendors → precise. claude-fable
  // and claude-mythos (the Mythos-class tier above Opus) need their own
  // prefix checks because PRECISE_MARKER does not match either name.
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

/** Concrete slug for a tier (exported for the planner and orchestrator). */
export function modelForTier(tier: ModelTier): string {
  return tierSlug(tier);
}
