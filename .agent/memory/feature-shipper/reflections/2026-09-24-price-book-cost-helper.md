## Self-Evaluation — one price-book helper for every cost figure (#4069, server half) — 2026-09-24

### What I set out to do
Make the run rollup and `get_usage_breakdown` price token classes and the cache saving through one pure helper in @oxagen/billing, record a per-model cache saving on the rollup, expose `costByClass` / `cacheSaving` / `hasUnpriced` on `get_run_cost`, and move `cacheSavingsMicros` off the in-code rate card onto the price book over price-boundary buckets. apps/app and credit metering were out of scope.

### What I actually did (measurable deltas)
- New `packages/billing/src/class-cost.ts` (`classesToResolve`, `priceClasses`) and `cache-savings.ts` (`netCacheSavingsFromBook`); `priceFrame` routes through `priceClasses` and returns `cacheSavingScaled`.
- `ModelBreakdown.cacheSavingMicros: bigint | null`; store serialises it and revives a missing key as null.
- `get_run_cost` contract, handler, doc and regenerated JSON schema.
- `readObservedModels` gained `frameStores: "gateway"` so the breakdown's saving covers only token_usage calls.
- Tests: 10 helper, 6 cache-savings, 6 new rollup, 2 store round-trip, 3 run.cost handler, 1 contract, 4 breakdown handler (1 rewritten from rate card to book), 2 telemetry.

### Quality of my decisions
- Best: adding `frameStores: "gateway"` rather than documenting the population mismatch. The saving now sits beside `cachedTokens` from the same calls, so the dashboard cannot print a saving larger than its own token counts support.
- Weakest: the breakdown's contract has no null, so an unpriced bucket silently contributes 0 and is only logged. A reader cannot tell a partial saving from a complete one. That needed a contract change I was told not to make here.

### What I could have done better
1. I resolved `input_uncached` for every frame that touched the cache, which adds one `resolvePriceEntry` book scan per frame. `priceFrame` still filters the whole book per class per frame; I should have measured the rollup over a large frame set before and after and recorded the delta.
2. I did not run the `.pg.test.ts` store suite against a real Postgres (the local recipe exists in shared lessons). The jsonb round trip is unit-proven through JSON text, but a real write/read through `upsertRunTotals` was not exercised.
3. I wrote the telemetry SQL edit by moving a CTE into a string with a Python line-slice. That was fragile, and I only caught the leftover duplicate `SELECT` by reading the file back. A structured edit would have been safer.

### What surprised me about this codebase/product
The rollup already stored `costByClass` but `get_run_cost` never returned it, which is why the Run page repriced tokens on the client. `metered_token_usage` is a view that unions `token_usage` with `durable_token_usage FINAL`, so both readers share it.

### Risks I am leaving behind (untouched on purpose, and why)
- apps/app still reprices with today's book until the Run page half lands after PR #4033.
- Rows rolled up before this change answer `cacheSaving: null` until their next rollup; no backfill job was added.
- The breakdown saving omits unpriced buckets without saying so on the wire.

### Confidence in the result: high for arithmetic and mapping (single-file tests green, pre-commit typecheck and lint green); medium for the gateway-only SQL, which is proven by query-text tests only, not against ClickHouse.
