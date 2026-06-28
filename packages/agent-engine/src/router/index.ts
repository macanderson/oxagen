/**
 * Router sub-package — cost-aware model selection and rate card.
 *
 * The single source of truth for how the engine selects models and prices
 * token usage. All router exports live here so consumers can import from
 * `@oxagen/agent-engine/router` (or from the main barrel which re-exports).
 */
export * from "./rate-card";
export * from "./model-router";
