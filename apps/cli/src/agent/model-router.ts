/**
 * Cost-aware model routing for the local agent.
 *
 * The CLI's job is to be the most cost-effective coding agent: spend Haiku money
 * on Haiku-sized work and only reach for Opus when the task actually needs it.
 * This module turns a task description (plus a few cheap structural signals) into
 * a {@link ModelTier} and a concrete gateway slug, deterministically and without
 * an extra LLM round-trip — encoding the CLAUDE.md operating-model table in code.
 *
 * It also vendors a small provider rate card so the agent can *estimate and
 * report* the dollar cost of a run. The numbers mirror
 * `packages/billing/src/pricing.ts` (the platform's single source of truth);
 * they are duplicated here only so the standalone `oxagen` bin stays lean and
 * does not pull in @oxagen/billing (Stripe et al.). Keep them in sync.
 */
import type { ModelTier } from "./fleet/types.js";
import type { UsageTotals } from "./fleet/types.js";
import { readConfig } from "../lib/config.js";

/** A tier's concrete gateway slug, overridable per-env to track gateway drift. */
function tierSlug(tier: ModelTier): string {
  switch (tier) {
    case "fast":
      return process.env["OXAGEN_LLM_FAST"] ?? "anthropic/claude-haiku-4.5";
    case "balanced":
      return process.env["OXAGEN_LLM_BALANCED"] ?? "anthropic/claude-sonnet-4.6";
    case "precise":
      return process.env["OXAGEN_LLM_PRECISE"] ?? "anthropic/claude-opus-4.8";
  }
}

export const TIERS: ModelTier[] = ["fast", "balanced", "precise"];

/** Human label for a tier, for the agents screen and `--explain` output. */
export function tierLabel(tier: ModelTier): string {
  return tier === "fast" ? "Haiku" : tier === "balanced" ? "Sonnet" : "Opus";
}

// ── Rate card (USD per 1,000,000 tokens) ─────────────────────────────────────
// Longest-prefix match on the bare model family. Mirrors PROVIDER_RATE_CARD.

interface Rate {
  inputPer1M: number;
  outputPer1M: number;
}

const RATES: Array<{ prefix: string; rate: Rate }> = [
  { prefix: "claude-opus", rate: { inputPer1M: 15.0, outputPer1M: 75.0 } },
  { prefix: "claude-sonnet", rate: { inputPer1M: 3.0, outputPer1M: 15.0 } },
  { prefix: "claude-haiku", rate: { inputPer1M: 1.0, outputPer1M: 5.0 } },
  { prefix: "gpt-5", rate: { inputPer1M: 1.25, outputPer1M: 10.0 } },
  { prefix: "gpt-4o-mini", rate: { inputPer1M: 0.15, outputPer1M: 0.6 } },
  { prefix: "gpt-4o", rate: { inputPer1M: 2.5, outputPer1M: 10.0 } },
  { prefix: "gemini", rate: { inputPer1M: 1.25, outputPer1M: 5.0 } },
];

const FALLBACK_RATE: Rate = { inputPer1M: 3.0, outputPer1M: 15.0 }; // Sonnet — never zero-charge.

/** Resolve a gateway slug (e.g. "anthropic/claude-opus-4.8") to its token rate. */
export function rateFor(model: string): Rate {
  // Drop the "vendor/" prefix and dotted version so "anthropic/claude-opus-4.8"
  // matches the "claude-opus" family. Normalize dots→dashes for prefix tests.
  const family = model.split("/").pop() ?? model;
  for (const { prefix, rate } of RATES) {
    if (family.startsWith(prefix)) return rate;
  }
  return FALLBACK_RATE;
}

/** Estimated provider cost in USD for a token usage on a given model. */
export function estimateCostUsd(
  model: string,
  usage: { inputTokens?: number; outputTokens?: number },
): number {
  const rate = rateFor(model);
  const inCost = ((usage.inputTokens ?? 0) / 1_000_000) * rate.inputPer1M;
  const outCost = ((usage.outputTokens ?? 0) / 1_000_000) * rate.outputPer1M;
  return inCost + outCost;
}

/** Format a USD amount compactly for the TUI ("$0.0042", "$1.20", "<$0.0001"). */
export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** Add a per-call usage into a running total, pricing it on the call's model. */
export function accumulateUsage(
  total: UsageTotals,
  model: string,
  usage: { inputTokens?: number; outputTokens?: number },
): UsageTotals {
  return {
    inputTokens: total.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: total.outputTokens + (usage.outputTokens ?? 0),
    costUsd: total.costUsd + estimateCostUsd(model, usage),
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
const PRECISE_DOMAINS =
  /\b(auth|authn|authz|login|session|password|secret|credential|oauth|saml|sso|billing|payment|invoice|stripe|charge|refund|security|crypto|encrypt|decrypt|rls|tenant|migration|schema change|architecture|architect|data model|storage boundary|production incident|outage|race condition)\b/i;

// Words that signal genuine design / non-trivial reasoning → at least balanced.
const DESIGN_SIGNALS =
  /\b(design|refactor|redesign|rearchitect|debug|investigate|root[- ]cause|why|optimi[sz]e|performance|concurren|async|deadlock|integrate|cross[- ]package|end[- ]to[- ]end|e2e|new (feature|capability|endpoint|tool|service)|implement)\b/i;

// Words that signal trivial, mechanical work → fast tier is plenty.
const TRIVIAL_SIGNALS =
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
      signals.crossPackage ? "crosses package boundaries" : `multi-file (~${files} files)`,
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
 * Manual precedence (matches the existing fixed-model path): an explicit slug
 * (`--model`), `OXAGEN_MODEL`, or a pinned `config.model` always wins and routing
 * is skipped. Otherwise auto-route from the task signals.
 */
export function routeModel(
  signals: TaskSignals,
  override?: string,
): RouteDecision {
  const manual = override ?? process.env["OXAGEN_MODEL"] ?? readConfig().model;
  if (manual) {
    return { tier: tierForSlug(manual), model: manual, rationale: "pinned model" };
  }
  return classifyTier(signals);
}

/** Best-effort tier label for an arbitrary slug (for display of pinned models). */
export function tierForSlug(model: string): ModelTier {
  const family = model.split("/").pop() ?? model;
  if (family.startsWith("claude-opus") || family.startsWith("gpt-5")) return "precise";
  if (family.startsWith("claude-haiku") || family.includes("mini") || family.includes("flash"))
    return "fast";
  return "balanced";
}

/** Concrete slug for a tier (exported for the planner and orchestrator). */
export function modelForTier(tier: ModelTier): string {
  return tierSlug(tier);
}
