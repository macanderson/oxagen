/**
 * The model rate card — re-exported from `@oxagen/agent-engine`.
 *
 * This file USED to carry its own vendored copy of the rate card (rates,
 * cost projection, model pricing). That copy was byte-for-byte the same as
 * the engine's `router/rate-card.ts` except it had drifted one revision
 * behind — its `projectCost` was not yet cache-aware, so a cache-heavy turn's
 * projection could overstate cost and disagree with `estimateCostUsd`. Rather
 * than keep two copies in sync by hand (and re-introduce that drift), the CLI
 * now re-exports the engine's single source of truth. The engine deliberately
 * vendors these numbers away from @oxagen/billing so the standalone `oxagen`
 * bin stays lean (no Stripe et al.); this module just forwards them so every
 * existing `../rate-card.js` / `./rate-card.js` import keeps resolving.
 *
 * Behavioral note (intentional, from adopting the engine version): the engine's
 * `CostProjection` carries a `cachedTokens` field and `projectCost` splits
 * cached input at the cache-read rate, guaranteeing `projectCost(...).totalUsd`
 * equals `estimateCostUsd(model, usage)` (ADR-021 §6). The old CLI copy lacked
 * both — this upgrade is strictly more correct and additive for callers.
 */
export {
  RATE_CARD,
  FALLBACK_RATE,
  familyOf,
  rateFor,
  entryFor,
  estimateCostUsd,
  formatUsd,
  projectCost,
  compareModels,
  listRateCard,
} from "@oxagen/agent-engine";
export type {
  ModelRate,
  RateCardEntry,
  TokenUsage,
  CostProjection,
} from "@oxagen/agent-engine";
