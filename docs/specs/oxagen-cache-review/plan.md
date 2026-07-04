# Oxagen Cache Review — Implementation Plan

Companion to [`spec.md`](./spec.md). One ticket = one PR per repo convention; phases are ordered by ROI-per-risk and each is independently shippable. Estimates use the Linear scale (XS≤1h · S=half-day · M=1day · L=multi-day · XL=week+).

## Phase 0 — Measure first (prereq for proving every later phase)

**Goal:** cache activity becomes visible before we change behavior; the exec-summary estimates get a baseline to be checked against.

| # | Work | Files | Est |
|---|---|---|---|
| 0.1 | Extract `cacheCreationTokens` alongside `cacheReadTokens`; add `cache_write_tokens` to ClickHouse `token_usage` + OTEL attr. Telemetry-only — no billing change. | `packages/ai/src/stream.ts`, `generate-object.ts`, `packages/telemetry` (new migration), usage seam in `model-router.ts` | M |
| 0.2 | Derived metrics: hit-rate %, write tokens, estimated savings USD per org/model/surface; replace raw "Cached tokens" stat on the usage dashboard with hit-rate + dollars-saved + per-model table. | `packages/telemetry/src/clickhouse.ts`, `apps/app/.../billing/usage/page.tsx` | M |
| 0.3 | Bench baseline: run one fixed `packages/bench` task on the platform path; record billed input, cache read/write, per-step wall clock into `verifications/`. | `packages/bench` (no code change; scripted run) | S |

**Exit criteria:** dashboard shows hit-rate; baseline numbers captured. Labels: `observability`, `billing`. Priority P2.

## Phase 1 — Prompt-cache breakpoints in `@oxagen/ai` (the 80% lever)

**Goal:** transcript-tail caching on every surface; spec §4.1.

| # | Work | Files | Est |
|---|---|---|---|
| 1.1 | Extract a shared `withPromptCaching(messages, {system})` helper into `packages/ai` (system marker + last-2-tail markers, Anthropic-gated, ≤4 breakpoints). Unit-test marker placement. | new `packages/ai/src/prompt-cache.ts`, `stream.ts:256-299` | M |
| 1.2 | Apply the helper in `streamAgentReply` (replaces the current system-only block); fix the stale comment at `engine.ts:148`. | `packages/ai/src/stream.ts`, `packages/agent-engine/src/engine.ts` | S |
| 1.3 | Add system-block marker in `generateObjectFor` via the same helper (planner/evaluator/judge/select inherit). | `packages/ai/src/generate-object.ts:129-137` | S |
| 1.4 | CLI gateway adapter imports the shared helper; delete its local copy. | `apps/cli/src/agent/adapters/gateway-agent-ai.ts:110-180` | S |
| 1.5 | Integration test: ≥3-step tool loop asserting `cache_read_input_tokens > 0` from step 2; re-run the Phase-0 bench task and diff. | `packages/ai` tests, bench run | M |

**Exit criteria:** bench shows ≥50% input-token cost reduction on the multi-step task vs Phase-0 baseline; hit-rate visible on dashboard. Labels: `llm`, `agents`, `performance`. Priority P1 (unblocks the economics of everything else).

## Phase 2 — Billing correctness for cache writes

**Goal:** stop under-billing cache writes; spec §4.3. Sequenced after Phase 1 because P1 increases write volume and makes the leak bigger.

| # | Work | Files | Est |
|---|---|---|---|
| 2.1 | Add `cacheWritePer1M` to the rate-card shape; populate all three copies in one commit; add a cross-copy identity test so drift fails CI. | `packages/billing/src/pricing.ts`, `packages/agent-engine/src/router/rate-card.ts`, `apps/cli/src/agent/rate-card.ts` + new test | M |
| 2.2 | Cost formulas: `providerCostUsd`/`estimateCostUsd` add the write term; fix `projectCost`/`compareModels` to honor `cachedTokens` + writes. | same files | S |
| 2.3 | Verify metered totals vs a provider invoice window (telemetry-only), then flip `chargeUsageCredits` to the corrected formula; `pnpm billing:stripe-sync`. | `packages/billing/src/metering.ts`, `credits.ts` | M |

**Exit criteria:** billed cost = fresh×1 + read×0.1 + write×1.25 within rounding on a sampled day. Labels: `billing`. Priority P1. **Risk gate:** billing-manager review; do not flip the meter until 2.3's telemetry check passes.

## Phase 3 — Cache-aware compaction + routing stickiness

**Goal:** P1 savings survive long sessions; spec §4.2, §4.5.

| # | Work | Files | Est |
|---|---|---|---|
| 3.1 | Turn-boundary compaction at 80%; mid-turn trigger becomes a 92% safety valve. Test: prefix bytes identical across steps within a turn. | `packages/agent-engine/src/engine.ts:135-190`, `loop-driver.ts:79-148` | M |
| 3.2 | Mid-turn fallback compacts only above the last breakpoint; re-mark after. | `loop-driver.ts` | M |
| 3.3 | Real token estimates + context windows from model-cache capability data (replace 4-chars/token + hardcoded 200k). | `loop-driver.ts:79-107`, `packages/agent-engine/src/model-cache` | S |
| 3.4 | Router stickiness term for loop continuations; fix model-cache defects (`costPer1MInputTokens: 0`, provider inference, misleading `fetchModelsFromVercel` naming). | `router/model-router.ts`, `model-cache/index.ts` | M |

**Exit criteria:** long-session bench (forced compaction) retains ≥80% of Phase-1 hit-rate. Labels: `agents`, `performance`. Priority P2.

## Phase 4 — Server-side TTL caches (auth / IAM / billing gates) + cache hygiene

**Goal:** stop per-request Postgres round trips; one bounded cache utility everywhere; spec §4.4. **Security-sensitive — Opus-tier review required.**

| # | Work | Files | Est |
|---|---|---|---|
| 4.1 | `ttlCache<K,V>({ttlMs, maxSize})` shared utility + tests (expiry, LRU cap, explicit bust). | new `packages/cache` (or `@oxagen/web`) | S |
| 4.2 | API-key resolution cache (≤60s, positive-only), shared by API middleware + MCP context. Revocation-window test + docs. | `packages/auth/src/resolvers/api-key.ts`, `apps/api/src/middleware/auth.ts`, `apps/mcp/src/context.ts` | M |
| 4.3 | Session caching via Better Auth `cookieCache` (short maxAge); verify against prod-equivalent env (rateLimits-pluralization lesson). | `packages/auth/src/auth.ts:405-408` | M |
| 4.4 | IAM authz cache (≤30s per `${orgId}:${userId}`) with bust hooks on role mutations; billing-admission cache (≤15s per org, documented overrun bound). | `packages/iam/src/fetch-authz.ts`, `packages/billing/src/autoreload.ts` | L |
| 4.5 | Hygiene retrofit: size-cap entitlement cache; TTL+cap connector-schema Map; skills-registry TTL or mutation-driven refresh; CLI config-indexer memoization. | `packages/plugins`, `packages/ingestion`, `packages/skills`, `apps/cli/src/config/indexer.ts` | M |

**Exit criteria:** p50 API latency reduction measured on a hot route; Postgres read QPS drop visible; security review sign-off. Labels: `api`, `mcp`, `auth`, `security`, `performance`. Priority P2.

## Phase 5 (deferred — decide later, tickets not cut)

Redis/KV tier · Neo4j read memoization (per-run request-scoped memo acceptable as fast-follow) · embedding content-hash cache · Next.js cross-request caching · cross-subagent prefix sharing · CLI 1-hour TTL (measure inter-turn gaps in Phase 0 first). Rationale in spec §5.

## Sequencing & dependencies

```
Phase 0 ──► Phase 1 ──► Phase 2 (billing flip needs P1's write volume visible)
                └─────► Phase 3 (needs P1 markers to protect)
Phase 4 independent of 1–3; after Phase 0 for measurement.
```

## Linear

Parent ticket per phase in `oxagen-v2` (one ticket = one PR; rows above become sub-issues). Assignee Mac Anderson. Suggested priorities: Phase 1 & 2 = P1; Phase 0, 3, 4 = P2. Estimates per row above; phase-level: 0=M, 1=L, 2=L, 3=L, 4=XL.

## Standing rules for every phase

- Every new cache declares TTL, max size, and invalidation story in code comments — no unbounded Maps.
- Verify cache behavior via `usage` fields / ClickHouse, never by absence of errors (prompt-cache failures are silent).
- The three rate-card copies change together, enforced by test (2.1).
- Follow `oxagen-engineering-policy`; four-store boundaries: all cache telemetry → ClickHouse; no graph data in Postgres caches; no transactional state in ClickHouse.
