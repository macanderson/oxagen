/**
 * Group 7 typed contracts — the canonical, reconciled TypeScript surface every
 * pipeline group builds against.
 *
 * This barrel re-exports:
 *   - Group 1 (`./model-provider.ts`), Group 2 (`./router.ts`,
 *     `./orchestrator.ts`), and Group 4 (`./tools.ts`, minus `plan`) verbatim
 *     from their shipped modules — zero drift by construction, since these
 *     ARE the shipped types, not a second copy of them.
 *   - Fresh, standalone interface stubs for Group 3 (`./context.ts`), Group 5
 *     (`./monitors.ts`), Group 6 (`./tools.ts`'s `plan` slice + `./pipeline.ts`),
 *     and Group 8 (`./timeouts.ts`, `./metrics.ts`) — none of which have landed
 *     in this worktree yet.
 *   - The unified config shape (`./config.ts`), reconciled to compose the
 *     re-exported `Complexity`/`Quantization` rather than redeclaring them.
 *
 * The original `contracts/*.ts` stubs (from the Group 7 spec) predate several
 * of these shipped modules and disagree with them in a few places — see the
 * PR description's "Reconciliation notes" for the full list. Per the Group 7
 * brief, this surface follows the shipped code, not the stale stub JSON.
 */
export * from "./model-provider.js";
export * from "./router.js";
export * from "./orchestrator.js";
export * from "./context.js";
export * from "./tools.js";
export * from "./monitors.js";
export * from "./pipeline.js";
export * from "./timeouts.js";
export * from "./metrics.js";
export * from "./config.js";
