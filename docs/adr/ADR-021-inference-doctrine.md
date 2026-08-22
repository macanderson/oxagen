# ADR-021: Inference doctrine — deterministic-first, cache-aligned, structured-tool agentic coding

**Status:** Proposed (2026-07-06)
**Related:** ADR-033 (Stella engine core), ADR-009 (unified capability-tool model), ADR-010 (subagent fan-out via Inngest), ADR-017 (OpenTelemetry tracing), `docs/VISION.md`

## Context

Oxagen's agent runs on three surfaces — web app, API, MCP — through one shared engine. The mission is to consistently outperform every other agentic coding tool on **wall-clock time, output quality, token burn, context retrieval, and multi-hour mission planning**, while remaining the governed, grounded, metered backbone (the Stripe-for-agents wedge: every observed token flows through metering into billing).

Performance in an agentic system is not primarily a model problem; it is an **inference-engineering** problem. The dominant costs are: (1) model calls that a function could have made, (2) KV-cache misses caused by unstable prompt prefixes, (3) raw tool output (logs, diffs, test runs) flooding the context, and (4) fleet coordination overhead (dispatcher models, duplicated context, lock contention). This ADR fixes the doctrine that every engine, surface, and tool change is judged against.

## Decision

### 1. The determinism ladder

Never call a model where a function suffices. Every duty is implemented at the **lowest** rung that can do it:

1. **Pure function** (routing, deduplication, classification by rule, plan templating, diff validation, test selection)
2. **Index/graph lookup** (code-graph neighbors, engram retrieval fusion, capability manifest)
3. **Cached prior model output** (exact + semantic response cache)
4. **Small model** (single narrow judgment, structured output, heuristic fallback mandatory)
5. **Frontier model** (open-ended synthesis only)

Every model call site in `@oxagen/agent-engine` and its adapters must carry a one-line justification comment naming why the rungs below are insufficient. A model call without one is a defect. Existing deterministic assets (the tier model-router, heuristic evaluator/judge fallbacks) are the norm, not the exception.

### 2. KV-cache discipline

The prompt is an append-only, prefix-stable data structure:

- **Immutable per session:** system prompt, tool definitions (deterministically ordered), doctrine/skill text. Nothing per-turn may be interpolated into this block.
- **Per-turn content** (memory recall, plans, repo state, budget status) enters as user-turn or tool-result messages **after** the stable prefix.
- History is append-only within a mission; compaction replaces a contiguous prefix with a summary block exactly once per compaction event, never rewrites interior messages.
- Cache hit rate is a metered, dashboarded metric per surface. A surface whose cache read ratio degrades has a correctness bug, not a cost quirk.

### 3. Structured tools over generic execution

A generic `bash` tool is the floor, not the pattern. Any diagnostic or mechanical duty the agent performs more than rarely becomes a **contract-backed tool with typed output** (capability parity: contract → API → MCP), e.g. `debug_with_trace` returning a structured failure frame (failing step, error class, top stack frames, related trace spans, suspect files ranked by the code graph) instead of 10k lines of logs. Rules:

- **Raw output never enters context.** Every tool result passes a deterministic compressor (truncate, parse, rank, summarize-by-rule) before the model sees it. LLM summarization of tool output is a last resort (ladder rung 4–5).
- Tool descriptions are written for **routing precision**: one sentence of what it does, one of when to prefer it over neighbors, explicit anti-triggers. Overlapping tools with vague descriptions are how a model "uses the wrong tool" — that is a tool-registry defect, not a model defect.
- Tool sets are identical across surfaces except where the environment genuinely differs (local FS vs sandbox); each divergence is declared in the engine's surface manifest, not implicit.

### 4. Dispatcherless, token-optimized fleets

Fleet fan-out uses **zero dispatcher-model calls**. Work partitioning is deterministic: the planner emits a dependency- and file-graph-aware shard plan; the scheduler assigns shards by deterministic rules (dependency order, file-lock availability, cost tier). Subagents:

- share state through the blackboard and platform memory, not through re-narrated context;
- return **structured facts** (schema-validated), never transcripts;
- acquire file locks before mutating (see §5).

### 5. Lock authority and file-level state stay in Postgres

**File locks and work leases are transactional mutual-exclusion state, so they live in Postgres** — lease rows with atomic acquire (`INSERT … ON CONFLICT` / `SELECT … FOR UPDATE SKIP LOCKED`), TTL expiry, and **fencing tokens** (monotonic per-resource counters checked at write time so a stale lease-holder's late write is rejected). This extends the existing Inngest claim/lease mechanism (`packages/inngest-functions`, Fanout Phase 2) to file-path granularity rather than inventing a second lock system.

**Neo4j never enforces or mirrors a lock for launch.** A graph projection is eventually consistent and would leak branch/worktree-specific file paths into shared state without providing replay-grade evidence. File locks remain queryable in Postgres; exact file lineage belongs in the future immutable run-evidence ledger, and any coarse workspace projection must be derived from verified evidence.

### 6. Metering is a first-class output

Every inference emits usage to ClickHouse with surface, capability, model, cache-read split, and mission/trace lineage — this is the product (metering → billing), not telemetry overhead. A code path that calls a model without metering is a P0.

### 7. Surface parity is an invariant, not an aspiration

Behavior lives in the engine; surfaces own only adapters (ADR-033 ports). Any behavioral logic found in a surface (custom prompt text, tool filtering, retry policy, budget handling) is a defect to be pulled into the engine behind a port. Parity is enforced by a manifest test: the engine exports its per-surface configuration (tools, prompt hash, ports) and CI diffs the three surfaces against declared divergences.

### 8. Memory closes the loop

Recall is deterministic retrieval (engram salience/decay/fusion) injected per-turn (§2), never into the cached prefix. Every completed mission writes back: outcome, defect patterns, environment quirks. Consolidation (distill/dedupe) runs offline, not on the turn's critical path.

## Consequences

**Positive:** lower token burn and latency compound across every surface at once; the metering wedge gets cleaner data (cache split, per-capability attribution); fleets scale without dispatcher-model cost; lock correctness stops depending on graph sync lag.

**Negative / risks:** the determinism ladder adds review friction (justification comments); the parity manifest test must be built before it can enforce; extending the lease system to file granularity touches the Inngest fan-out path and needs careful TTL tuning to avoid orphaned locks blocking fleets (mitigated by fencing tokens + expiry sweeps).

## Enforcement

- New engine/tool PRs are reviewed against §1–§8; the Vision Gate covers mission drift, this ADR covers inference drift.
- The five-domain audit (2026-07-06) is triaged against this doctrine; each fix wave PR cites the sections it enforces.
