/**
 * Cost-aware model routing for the local agent — reconciled onto the engine.
 *
 * The CLI's job is to be the most cost-effective coding agent: spend Haiku money
 * on Haiku-sized work and only reach for Fable when the task actually needs it.
 * The *classifier* that turns a task's structural signals into a tier (the
 * PRECISE/DESIGN/TRIVIAL heuristics, the breadth thresholds, the cross-vendor
 * slug markers) is identical to the engine's and lives ONLY there —
 * `@oxagen/agent-engine`'s `classifyTier`/`tierForSlug`. Keeping one copy avoids
 * the drift risk of two heuristics slowly diverging.
 *
 * Three behaviours stay CLI-specific and are the reason this is a thin wrapper
 * rather than a bare re-export (all three are preserved on purpose — see each):
 *
 *   1. `tierSlug` — a tier's concrete gateway slug comes from the CLI's model
 *      *catalog* (`./model-catalog.ts` → `LATEST_ANTHROPIC`), not a hard-coded
 *      literal, so a Claude family bump lands in one place and flows here
 *      automatically. `classifyTier`/`modelForTier` below re-slug the engine's
 *      tier decision through this catalog. (Env overrides `OXAGEN_LLM_*` still
 *      win, exactly as in the engine.)
 *   2. `routeModel` additionally honours a pinned `config.model` (the CLI's
 *      persisted `--model`) — the engine deliberately does NOT read config and
 *      leaves that to the caller.
 *   3. `tierForSlug` classifies a pinned `claude-fable-*` slug as `precise` —
 *      Fable is the Claude 5 flagship; the engine's marker set omits it, so we
 *      intercept it before delegating.
 *
 * Dollar costs come from the rate card (`./rate-card.ts`, itself a re-export of
 * the engine's single source of truth); the pricing helpers are re-exported
 * here so call sites that import them from the router keep working.
 */
import {
  classifyTier as engineClassifyTier,
  tierForSlug as engineTierForSlug,
} from "@oxagen/agent-engine";
import type {
  ModelTier,
  TaskSignals,
  RouteDecision,
} from "@oxagen/agent-engine";
import { readConfig } from "../lib/config.js";
import { estimateCostUsd, rateFor, formatUsd } from "./rate-card.js";
import { LATEST_ANTHROPIC } from "./model-catalog.js";

// Pricing helpers re-exported so call sites that import them from the router
// keep working. The authoritative definitions live in ./rate-card.ts (→ engine).
export { estimateCostUsd, rateFor, formatUsd };
// Tier type + signal/decision shapes come straight from the engine.
export type { ModelTier, TaskSignals, RouteDecision };
// The identical-everywhere pieces: tier list, tier label, and per-call usage
// accumulation (the engine's version additionally prices cached input tokens —
// a superset of the CLI's old copy, so re-exporting it is strictly more
// correct and additive for existing callers).
export { TIERS, tierLabel, accumulateUsage } from "@oxagen/agent-engine";

/**
 * A tier's concrete gateway slug, resolved from the CLI model catalog so a
 * family bump lands in one place; env vars still win for gateway drift ahead of
 * a catalog bump. This is behaviour (1) above — the engine hard-codes literals
 * here, the CLI reads the catalog.
 */
function tierSlug(tier: ModelTier): string {
  switch (tier) {
    case "fast":
      return process.env["OXAGEN_LLM_FAST"] ?? LATEST_ANTHROPIC.haiku;
    case "balanced":
      return process.env["OXAGEN_LLM_BALANCED"] ?? LATEST_ANTHROPIC.sonnet;
    case "precise":
      return process.env["OXAGEN_LLM_PRECISE"] ?? LATEST_ANTHROPIC.fable;
  }
}

/**
 * Choose the cheapest tier that can do the job, then resolve it to a concrete
 * slug through the CLI catalog. The tier *decision* (and its human rationale)
 * is the engine's; only the slug is re-mapped, so a catalog family bump flows
 * through without touching the classifier.
 */
export function classifyTier(signals: TaskSignals): RouteDecision {
  const decision = engineClassifyTier(signals);
  return { ...decision, model: tierSlug(decision.tier) };
}

/**
 * Resolve the model for a task, honouring a manual override first.
 *
 * Manual precedence (behaviour (2) above): an explicit slug (`override`),
 * `OXAGEN_MODEL`, or a pinned `config.model` always wins and routing is skipped.
 * Otherwise auto-route from the task signals.
 */
export function routeModel(
  signals: TaskSignals,
  override?: string,
): RouteDecision {
  const manual = override ?? process.env["OXAGEN_MODEL"] ?? readConfig().model;
  if (manual) {
    return {
      tier: tierForSlug(manual),
      model: manual,
      rationale: "pinned model",
    };
  }
  return classifyTier(signals);
}

/**
 * Best-effort tier label for an arbitrary slug (for display of pinned models).
 * Behaviour (3) above: Fable classifies precise here even though the engine's
 * marker set omits it; everything else defers to the engine's cross-vendor
 * classifier so the marker regexes live in exactly one place.
 */
export function tierForSlug(model: string): ModelTier {
  const family = (model.split("/").pop() ?? model).toLowerCase();
  if (family.startsWith("claude-fable")) return "precise";
  return engineTierForSlug(model);
}

/** Concrete slug for a tier (exported for the planner and orchestrator). */
export function modelForTier(tier: ModelTier): string {
  return tierSlug(tier);
}
