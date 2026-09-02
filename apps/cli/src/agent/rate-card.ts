/**
 * The model rate card — re-exported from `@oxagen/agent-engine`.
 *
 * The engine owns the single copy of the rates, the cost math, and the model
 * pricing table. This file only forwards them, so every `./rate-card.js` import
 * in the CLI keeps resolving without a second copy of the numbers to keep in
 * sync. The engine vendors these numbers away from `@oxagen/billing` on purpose,
 * so the standalone `oxagen` binary stays small (no Stripe and friends).
 *
 * One thing to know when reading cost output: `projectCost` prices cached input
 * tokens at the cache-read rate, so `projectCost(...).totalUsd` always equals
 * `estimateCostUsd(model, usage)` (ADR-021 §6).
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
