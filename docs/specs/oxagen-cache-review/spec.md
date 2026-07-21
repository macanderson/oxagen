# Oxagen Cache Review — Spec

**Status:** Proposed · **Date:** 2026-07-03 · **Scope:** agent engine, in-app agent, CLI, MCP, API, billing/telemetry
**Companion:** [`plan.md`](./plan.md) (phased implementation plan)

---

## Executive summary — estimated gains, risks, and whether this is worth the tokens

### Estimated gains (with assumptions stated — treat as ranges, not promises)

| Lever | Estimated effect | Basis |
|---|---|---|
| **P1. Transcript-tail + tools prompt-cache breakpoints in `@oxagen/ai`** (platform CLI path, in-app chat, agent-engine loop, all inherit) | **70–85% reduction in input-token cost of multi-step agent loops**; total LLM spend on agentic traffic down an estimated **40–60%** (loops are input-dominated). TTFT on later loop steps improves an estimated 30–70% (cached prefill is skipped). | Anthropic cache reads bill at 0.1× base input; writes at 1.25× (5-min TTL). Worked example below. The exact pattern already exists and is proven in `apps/cli/src/agent/adapters/gateway-agent-ai.ts:126-144` — this is a port, not an invention. |
| **P2. Prompt caching in `generateObjectFor`** (planner / evaluator / judge / select) | ~90% off the shared-rubric prefix for every structured-output call beyond the model's minimum cacheable size (1024–4096 tokens depending on model). Material for best-of-N pipelines where one rubric is re-sent per candidate. | Same 0.1× read economics; these call sites share large stable system prompts today and cache nothing (`packages/ai/src/generate-object.ts:129-137`). |
| **P3. Bill cache writes correctly** | Recovers a systematic **under-billing of 25% on every cache-write token** (billed at 1× fresh today, provider charges us 1.25×). Estimated 2–5% of input-token revenue on cache-heavy traffic; grows as P1 lands and write volume rises. | No `cacheWritePer1M` in any of the three rate cards; live meter never reads `cache_creation_input_tokens` (details §4.3). |
| **P4. Auth/IAM/billing-gate TTL caches in API + MCP** | Removes 1–2 uncached Postgres round trips per API/MCP request and ~5 selects per gated `invoke()`. Estimated **10–50 ms p50 latency reduction per request** and a large cut in Postgres read QPS. | Every request does `apiKeys.findFirst` / `sessions.findFirst` uncached; IAM and billing gates are uncached; only the entitlement gate has a (30s) TTL cache to copy (§4.4). |
| **P5. Cache-warm-aware compaction + routing** | Preserves the P1 savings in exactly the long sessions where they matter most (compaction currently rewrites cached-prefix bytes and permanently busts warmth; model switches silently discard it). | §4.2, §4.5. |

**Worked example for P1** (the headline number): a 20-step agent turn with an 8k-token system+tools prefix and a transcript growing ~2k tokens/step re-sends ≈580k input tokens today, all at full price. With tail breakpoints: ~540k of that becomes cache reads (0.1×) and ~48k becomes cache writes (1.25×) → ≈114k full-price-equivalent tokens, an **~80% input-cost reduction for that turn**. Real turns vary; the direction and order of magnitude do not.

### Risks (ranked)

1. **Billing changes touch revenue (P3).** Mispricing cache writes in the *other* direction, or double-counting reads, corrupts customer invoices. Mitigate: land metering first behind telemetry-only, verify against ClickHouse + a known Anthropic invoice before flipping the billing meter; the three rate cards are hand-synced copies and must change together (drift risk is pre-existing and documented in-code).
2. **Auth caching is security-sensitive (P4).** A TTL cache on API-key/session resolution creates a revocation window (revoked key keeps working for up to TTL). Mitigate: short TTL (≤30–60s, matching the existing entitlement-cache precedent), cache only positive lookups, never cache secrets themselves, and get an explicit security review (this is Opus-tier work per repo policy).
3. **Cache writes can *increase* cost on short conversations.** A 1-turn conversation that writes cache and never reads it pays 1.25× for nothing. With 5-min TTL the break-even is 2 requests — agent loops always clear it, but single-shot `generateObject` calls may not. Mitigate: only mark prefixes above the model minimum and only on call sites with expected reuse.
4. **Correctness subtleties in the prompt-cache protocol.** Max 4 breakpoints/request; 20-content-block lookback window (long tool-heavy turns can silently miss the prior entry — the gateway adapter's 2-tail-breakpoint trick exists precisely for this); minimum cacheable prefix is model-dependent (1024–4096 tokens) and failures are silent (`cache_creation_input_tokens: 0`, no error). Mitigate: assert on `usage` fields in integration tests, not on absence of errors.
5. **Per-process caches in serverless are not shared.** Any in-memory TTL cache (P4) is per-warm-instance — fine for read caching, already true of the rate limiter and entitlement cache. The distributed-cache question (Redis/KV, currently absent from the entire repo) is deliberately deferred to an optional phase; adopting it is an infra decision, not a prerequisite.
6. **Staleness.** Every new cache is a new staleness surface (skills registry already has this bug: tenant skills cached forever per instance). Every cache introduced in this plan must declare TTL, size cap, and invalidation story — no more unbounded hand-rolled Maps.

### Honest verdict: is burning tokens in this direction worth it?

**Yes for Phases 0–2, strongly.** The single highest-leverage change (P1) is small — the code already exists in the gateway adapter and needs porting into `packages/ai/src/stream.ts`, which every surface (in-app chat, platform CLI, agent-engine, MCP-triggered agent work) flows through. It is a provider-config change, not an architecture change, and its effect is directly measurable in `usage.cache_read_input_tokens`. Combined with the billing-correctness fix (P3), this is the rare project that **cuts our COGS and fixes under-billing at the same time**.

**Measured for Phases 3–4.** Cache-aware compaction and auth caching are real wins but carry correctness/security risk; they should follow the measurement infrastructure (Phase 0), not precede it.

**No, for now, on the speculative tail.** Distributed cache (Redis), graph-read memoization, embedding content-hash caching, and Next.js cross-request data caching are genuine opportunities but lower ROI-per-risk today. They are specified here so the decision is recorded, and deferred.

What this is *not*: there is no caching catastrophe. The team already got the hard invariants right — the system prompt is deliberately byte-stable, memory recall is kept out of the cached block (the PR #437 rule held on every surface checked), the local code-graph caching is genuinely well-built, and turbo remote caching is on. The problem is that prompt caching stops at the system block, the economics of caching are invisible (no write metering, no hit-rate telemetry), and the serving path has zero request-level data caching. Those are all fixable with bounded effort.

---

## 1. Background and goals

Oxagen runs LLM agent loops on four surfaces — the in-app chat agent (`apps/app` → `/api/v1/chat/stream`), the CLI coding agent (`apps/cli` + `packages/agent-engine`), the MCP server (`apps/mcp`), and the REST API (`apps/api`). All LLM calls funnel through `@oxagen/ai` (`packages/ai`). This spec reviews every cache in the monorepo — LLM prompt caches, in-process data caches, on-disk CLI caches, and build caches — and defines the improvement program.

Goals, in priority order:

1. **Cut LLM input spend and latency** on agentic loops via full use of provider prompt caching.
2. **Make cache economics visible and correct** — meter cache writes, bill them at provider rates, expose hit-rate and dollar-saved telemetry.
3. **Stop paying Postgres round trips for immutable-within-seconds lookups** on every API/MCP request.
4. **Make agent-side behaviors (compaction, model routing) cache-aware** so wins survive long sessions.
5. **Standardize cache hygiene** — every cache has a TTL, a size cap, and an invalidation story.

Non-goals: introducing a distributed cache tier (deferred, §6), caching Neo4j graph reads (deferred), changing the four-store data model in any way.

## 2. Prompt-caching economics (reference)

Anthropic prompt caching (via the AI gateway) is a **strict byte-prefix match**, rendered in order `tools → system → messages`. Key facts the design relies on:

- Cache **reads bill at ~0.1×** base input price; **writes at 1.25×** (5-min TTL) or 2× (1-hour TTL). Break-even at 5-min TTL is 2 requests.
- Max **4 breakpoints** per request; each breakpoint looks back at most **20 content blocks** for a prior entry.
- Minimum cacheable prefix is **model-dependent (1024–4096 tokens)**; below it, caching silently no-ops.
- Any byte change anywhere in the prefix invalidates everything after it; caches are **model-scoped** (switching models = cold cache).
- Verification signal: `usage.cache_read_input_tokens` / `cache_creation_input_tokens` on every response.

## 3. Current state — honest assessment

Findings below were produced by four parallel read-only audits (agent-engine/ai; CLI/code-graph; app/API/MCP; cross-cutting) with file:line evidence. ✅ = healthy, ⚠️ = gap, ❌ = defect.

### 3.1 What is already good

- ✅ **System-prefix breakpoint exists on the shared path.** `streamAgentReply` marks the system block `anthropic.cacheControl: ephemeral`, carried as a leading system message because only message-level providerOptions hold the marker (`packages/ai/src/stream.ts:268-285`). No-op for non-Anthropic models — safe cross-vendor.
- ✅ **System prompt is deliberately cache-stable.** `packages/agent-engine/src/prompt/system-prompt.ts:1-8` documents the invariant; only session-stable inputs are interpolated.
- ✅ **Memory recall stays out of the cached block (PR #437 rule held).** Recall rides as a user message inserted near the tail on both the engine path (`engine.ts:91-132`) and the chat route (`apps/app/.../recall-context.ts:142-160`), never folded into `system`.
- ✅ **The CLI gateway/BYOK adapter does caching correctly** — system block + the **last 2 transcript messages** marked each call so the growing prefix re-reads at 0.1× and the 20-block lookback still hits after a new message lands (`apps/cli/src/agent/adapters/gateway-agent-ai.ts:120-144,178`). This is the reference implementation for P1.
- ✅ **Cache-read accounting is wired end-to-end.** `cacheReadTokens` → `cachedTokens` → priced as a subset of input (`packages/billing/src/pricing.ts:133-144`), metered to ClickHouse `token_usage.cached_tokens` and OTEL (`stream.ts:312-347`).
- ✅ **Local code-graph caching is well-built.** The checkout-local DuckDB store uses sha256 content hashes for incremental parsing (`apps/cli/src/daemon/code-graph/store.ts`), and embeddings are persisted and reused by provider/dimension (`context/semantic-index.ts:99-148`). This cache stays local; it is not a client-authored workspace-graph upload path.
- ✅ **Turbo remote caching enabled** in CI and locally (`turbo.json:28`, `pipeline.yml:14-15`).
- ✅ **Entitlement gate has a real TTL cache** — 30s in-memory Map keyed `${orgId}:${workspaceId}` (`packages/plugins/src/entitlements/entitlement-service.ts:24-82`). This is the pattern P4 generalizes.

### 3.2 Prompt-caching gaps (the big money)

- ❌ **The growing transcript is never cached on the shared path.** The engine loops up to 256 steps, re-sending the whole conversation each step (`packages/agent-engine/src/engine.ts:135-174,291`), and `stream.ts` marks only the system block. Every tool-loop step re-bills the entire transcript at full input price. The in-code comment "the prompt cache keeps each resend cheap" (`engine.ts:148`) overstates reality. **This asymmetry means the default metered platform path — paying customers — gets the worst caching, while BYOK users get the best.**
- ❌ **`tools` are never marked cacheable on any path.** Tool definitions are large and stable — ideal cache content (they do ride the system breakpoint on Anthropic's render order, but only when the system marker is present and stable).
- ❌ **`generateObjectFor` sets no breakpoints at all** (`packages/ai/src/generate-object.ts:129-137`). Planner, evaluator, judge, and select re-send large shared rubrics at full price on every call (`packages/agent-engine/src/planner/`, `evaluate/`).
- ❌ **Compaction is cache-hostile.** It fires mid-turn at >80% of context (`engine.ts:182-184`) and truncates the content of every message between the first user message and the last 8 (`loop-driver.ts:127-148`) — rewriting cached-prefix bytes. The compacted array becomes next turn's history, so the busted prefix is permanent. Token estimation is a ~4 chars/token heuristic with hardcoded context windows (`loop-driver.ts:79-107`).
- ⚠️ **The model router ignores cache warmth.** No stickiness to keep a conversation on the model whose prefix is warm; a mid-session switch silently pays a full cold prefill (`packages/agent-engine/src/router/model-router.ts`).
- ⚠️ **The per-turn planner (PR #535) is an extra uncached metered call every turn** — by design its digest prompt varies per turn so it cannot cache; it does *not* pollute the main loop's prefix (`apps/cli/src/repl/plan-turn.ts:30-33,138-165`). Cost/latency, not correctness.
- ⚠️ **Fleet fan-out cold-starts N prefixes.** Subagents share the AgentAi port but not conversation or an engineered common prefix (`fleet-turn.ts:106-125`).
- ⚠️ **Chat route re-reads workspace prompt config + skill index from Postgres and races a live Neo4j memory recall on every turn** (`apps/app/src/app/api/v1/chat/stream/route.ts:366-408,598-601`), uncached across requests.

### 3.3 Cache economics gaps (billing/telemetry)

- ❌ **Cache writes are not metered or priced anywhere on the live path.** Only `cacheReadTokens` is extracted (`stream.ts:312`, `generate-object.ts:146`); `cache_creation_input_tokens` folds into plain `inputTokens` and bills customers at 1× while the provider charges 1.25×. No `cacheWritePer1M` exists in any rate card (`packages/billing/src/pricing.ts:43-100`, `packages/agent-engine/src/router/rate-card.ts:58-67`, `apps/cli/src/agent/rate-card.ts:56-65` — three hand-synced copies). Analytics columns for cache writes exist but only in Claude-session backfill tables, decoupled from billing (`packages/telemetry/src/migrations/0006/0007`).
- ⚠️ **`projectCost`/`compareModels` ignore `cachedTokens` entirely** (`rate-card.ts:148-179`) — projections overstate cost for cache-heavy usage; the router's cost comparisons are wrong in the same direction.
- ⚠️ **No hit-rate or dollar-saved telemetry.** The usage dashboard shows a raw "Cached tokens" count only (`apps/app/.../billing/usage/page.tsx:110,148-192`); no hit-rate %, no savings, no per-model breakdown; per-metric `costMicros` hardcoded 0.

### 3.4 Server-side data caching gaps (API/MCP/app)

- ❌ **API-key and session auth hit Postgres uncached on every request** — `resolveApiKey` → `apiKeys.findFirst` (`packages/auth/src/resolvers/api-key.ts:71-99`), `resolveSession` → `sessions.findFirst` (`session.ts:110-123`); MCP re-resolves the API key on **every tool call** (`apps/mcp/src/context.ts:97-141`). Better Auth `cookieCache` intentionally disabled (`packages/auth/src/auth.ts:408`).
- ❌ **IAM authz (~5 selects across 2 tenant-db blocks) and billing admission run uncached on every gated `invoke()`** (`packages/iam/src/fetch-authz.ts:173-259`, `packages/billing/src/autoreload.ts:30-44`). Of the three bootstrap gates, only entitlements cache.
- ⚠️ **No distributed cache exists anywhere** (no redis/upstash/kv dependency in the repo). Rate limiter is a per-process fixed-window Map that self-documents "swap for Redis/Upstash later" and enforces per-warm-instance, not global, limits (`apps/api/src/middleware/rate-limit.ts:39-74`).
- ⚠️ **No cross-request Next.js data caching** in `apps/app` — request-scoped React `cache()` + `revalidatePath` only; no `unstable_cache`/`"use cache"`/fetch revalidation anywhere.
- ⚠️ **No app-level caching of graph reads** — `ontology.query`/`ontology.neighbors` hit Neo4j fresh on every call and agent loops repeat identical queries across steps (`packages/handlers/src/ontology.{query,neighbors}.ts`).
- ⚠️ **No content-hash dedupe on the general embedding path** — `packages/ai/src/embed.ts:51-55` re-embeds identical text every call; the local code-graph cache does not cover this shared embedding path.

### 3.5 Cache-hygiene defects (small but real)

- ❌ **Skills registry caches tenant DB skills forever per instance** — new workspace skills invisible until `refresh()`/restart (`packages/skills/src/registry.ts:21-55`).
- ⚠️ **Connector-schema Map is unbounded** — no TTL, no eviction (`packages/ingestion/src/connector-schema-loader.ts:148,221-282`); entitlement cache has no size cap.
- ⚠️ **No shared cache utility exists** — every cache in the repo is hand-rolled (Map + ad-hoc TTL or nothing).
- ⚠️ **CLI model-capability cache** (`~/.oxagen/model-cache.json`, 24h TTL) hardcodes `costPer1MInputTokens: 0`, labels non-Claude models `"unknown"`, and fetches `api.anthropic.com` directly despite "Vercel" naming (`packages/agent-engine/src/model-cache/index.ts:79-132`).
- ⚠️ **CLI config indexer re-scans the filesystem on every invocation**, no memoization (`apps/cli/src/config/indexer.ts:193-320`).

## 4. Design

### 4.1 P1 — Full prompt caching in `@oxagen/ai` (one change, every surface inherits)

Port the gateway adapter's `withPromptCaching` pattern into `packages/ai/src/stream.ts` so the shared path marks, per request:

1. the system block (already done),
2. **the last two transcript messages** (`anthropic.cacheControl: ephemeral` via message-level providerOptions) — two tail markers so the longest-prefix lookup still hits the previous step's entry after a new message lands within the 20-block lookback,
3. tool definitions ride the system breakpoint by render order; verify with usage assertions rather than adding a redundant marker (budget is 4 breakpoints total — reserve the spare).

Rules: apply only for Anthropic-family model ids (the providerOptions namespace is already a no-op elsewhere, but be explicit); never mark volatile content (the recalled-memory user message may be marked *only* if it is in the tail position, which it is by construction); keep `generate-object.ts` symmetrical (system-block marker there — call sites with shared rubrics are the win; single-shot calls below the model minimum silently no-op, which is the safe default).

The CLI platform adapter (`platform-agent-ai.ts`) needs no change — it inherits via the server route → `streamAgentReply`. The gateway adapter keeps its local implementation; extract the marker helper into `@oxagen/ai` so there is exactly one implementation and the CLI imports it (kill the copy).

**Acceptance:** integration test drives a ≥3-step tool loop against the gateway and asserts `cache_read_input_tokens > 0` from step 2 on, and that read tokens ≈ prior-step prompt size. A unit test asserts marker placement (system + exactly 2 tail messages, ≤4 total).

### 4.2 P2 — Cache-aware compaction

Change `compactMessages`/engine so warmth survives:

- **Compact at turn boundaries, not mid-step**, when possible: raise the mid-turn trigger to a hard-ceiling safety valve (e.g. 92%) and add a between-turns compaction pass at the existing 80% threshold. Within a turn, the transcript then stays append-only and every step's prefix re-reads warm.
- When mid-turn compaction must fire, **compact only the region above the last cache breakpoint** (i.e. everything except the tail the markers cover), accept the one-time re-write, and re-mark.
- Replace the 4-chars/token estimate and hardcoded context windows with the model-cache capability data (already on disk) — the crude estimate is what makes compaction fire earlier than needed.

### 4.3 P3 — Cache-write metering and pricing (billing correctness)

- Extract `cacheCreationTokens` from `usage.inputTokenDetails` alongside `cacheReadTokens` in `stream.ts` and `generate-object.ts`; carry through the usage seam (`model-router.ts:60-69`), ClickHouse `token_usage` (new column `cache_write_tokens`), and OTEL.
- Add `cacheWritePer1M` to the rate-card shape and populate all **three** copies in the same commit (billing, agent-engine, CLI — they are deliberate vendored copies; add a cross-copy sync test that asserts the tables are identical so drift fails CI).
- Update `providerCostUsd`/`estimateCostUsd`: `cost = fresh×base + read×0.1×base + write×1.25×base`, keeping cached/write as subsets of `inputTokens` with clamping. Fix `projectCost`/`compareModels` to honor both fields.
- Ship metering first (telemetry-only), verify totals against a provider invoice, then flip `chargeUsageCredits` to the corrected formula and run `pnpm billing:stripe-sync`.

### 4.4 P4 — Request-level TTL caches for auth/IAM/billing gates

Introduce one shared utility, `@oxagen/web` (or a new tiny `packages/cache`): `ttlCache<K,V>({ ttlMs, maxSize })` — a bounded Map with expiry sweep, mirroring the entitlement cache but with a size cap. Then:

- **API-key resolution:** cache positive resolutions keyed by key-prefix+hash for ≤60s (config-driven). Never cache negatives or secrets; revocation window documented and accepted (matches the entitlement precedent). Applies to `apps/api` middleware and `apps/mcp` context identically since both call `resolveApiKey`.
- **Session resolution:** prefer enabling Better Auth `cookieCache` (short maxAge) over a hand-rolled cache — it is the vendor-supported mechanism; verify against a prod-equivalent environment (the `rateLimits` pluralization incident is the cautionary tale).
- **IAM authz:** cache the fetched role/permission set per `${orgId}:${userId}` for ≤30s inside `fetch-authz.ts`, with explicit bust on role-mutation handlers.
- **Billing admission:** cache `effectiveBalance` per org for ≤15s — admission is advisory (the meter is authoritative), so a short window is safe; document that a hard-cutoff org can overrun by ≤15s of spend.
- Retrofit the utility onto the entitlement cache (size cap) and connector-schema loader (cap + TTL), and give the skills registry a TTL or mutation-driven `refresh()`.

Security review required before merge (auth/billing surface → Opus-tier per repo policy).

### 4.5 P5 — Cache-warmth-aware routing (small, opportunistic)

The router already sees the conversation; add a stickiness term: if the previous step ran on model M and the request is a loop continuation, prefer M unless the override is explicit. This is a heuristic weight, not a hard pin. Fix the model-cache defects while in there (`costPer1MInputTokens: 0`, provider inference).

### 4.6 Telemetry & dashboard (Phase 0 output)

- New derived metrics from `token_usage`: `cache_hit_rate = cached / (input + cached)`, `cache_write_tokens`, `estimated_savings_usd = cached × (base − 0.1×base) − write × 0.25×base` per org/model/surface.
- Usage dashboard: replace the raw "Cached tokens" stat with hit-rate %, dollars saved, and a per-model table.
- ClickHouse only (append-only runtime events) — no Postgres/Neo4j involvement; respects the four-store boundaries.

## 5. Explicitly deferred (recorded decisions)

| Item | Why deferred |
|---|---|
| Redis/Upstash/Vercel KV tier (global rate limiting, shared entitlement/auth cache) | New infra dependency + vendor decision; per-process TTL caches capture most of the win at zero infra cost. Revisit when multi-instance rate-limit correctness becomes a customer-visible problem. |
| Neo4j graph-read memoization (`ontology.query`/`neighbors`) | Needs an invalidation story tied to ingestion writes; risk of stale graph answers in agent loops. Cheap per-turn (request-scoped) memo inside a single engine run is acceptable as a fast-follow. |
| Embedding content-hash cache in `embed.ts` | Real but small vs P1; needs a storage decision (Postgres table keyed by hash+model+dim). |
| Next.js cross-request data caching (`"use cache"` / `unstable_cache`) | Tenancy-scoped keys make this easy to get wrong (cross-tenant leak risk); revisit per-surface with explicit keys after P4. |
| Cross-subagent prefix sharing in fleet fan-out | Requires a common system-prefix architecture across agent definitions; note for the fleet Phase 2 spec. |
| CLI 1-hour cache TTL between user turns | 2× write cost needs ≥3 reuses to pay off; measure inter-turn gap distribution first (Phase 0 telemetry). |

## 6. Verification plan

- Unit: marker-placement tests in `packages/ai`; rate-card sync test; cost-formula tests incl. write premium; TTL-cache utility tests (expiry, cap, bust).
- Integration: gateway loop test asserting `cache_read_input_tokens` step-over-step; compaction test asserting byte-identical prefix within a turn; auth-cache revocation-window test.
- Economics: before/after ClickHouse comparison on a fixed bench task (`packages/bench`) — input tokens billed, cache reads/writes, wall-clock per step. This is the number the exec summary's estimates get checked against.
- Every phase writes artifacts to `verifications/<session-id>/` per repo policy.
