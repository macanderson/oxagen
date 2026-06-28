# ADR-019: Unified agent engine — one brain across CLI and platform

**Status:** Accepted (2026-06-27)
**Supersedes (in part):** the narrow "share only the inner loop + tools" scope of `docs/superpowers/plans/2026-06-27-in-app-coding-agent-phase1.md`
**Related:** ADR-007 (docker sandbox), ADR-011 (Vercel sandbox driver), ADR-009 (unified capability-tool model), ADR-010 (subagent fan-out via Inngest), ADR-016 (CLI daemon live code-graph)

## Context

We are adding an online (in-app) coding agent that edits connected repos, opens PRs, and monitors CI. We already have a sophisticated coding agent in `apps/cli`. Without a deliberate decision, we ship **two coding agents** with diverging behavior.

An evaluation of both sides (2026-06-27) found:

- **The CLI holds the real intelligence.** `apps/cli/src/agent/` contains a 6-stage pipeline (evaluate → enhance → route → execute → **judge → revise**), a deterministic model-router (tier classifier encoding the operating-model table, zero LLM calls), a planner + concurrency/dependency/file-lock-aware fleet orchestrator, an evaluator and a separate-advisor judge (both `generateObject` with heuristic fallbacks), a per-turn trace subsystem, plus local memory (DuckDB/engram) and a local FS-built code-graph. **Almost all of it is pure, transport-agnostic logic** — the engine has zero Ink imports and drives the terminal purely through `onText`/`onToolCall`/`onStage` callbacks.
- **The platform has only the chat capability loop** (`streamAgentReply` + `materializeTools`). There is **no platform coding-loop primitive**. Its strength is the infrastructure the CLI lacks: metering/credits, tenant scope, sandbox, IAM/approval, Postgres/ClickHouse persistence, and the ingested Neo4j graph.
- **The CLI's loop calls `streamText` directly**, bypassing all platform metering/credits/tenancy. The platform's `streamAgentReply` adds ClickHouse telemetry + credit charging + tenant-scope capture.

The only genuinely environment-specific seams are: the **filesystem** (local vs sandbox), the **AI call** (BYOK/unmetered vs metered), the **code-graph** (local index vs Neo4j), and **memory/trace** (local files vs platform stores). Everything else — pipeline, router, evaluator, judge, planner, fleet scheduler, trace logic, system-prompt assembly — is identical logic.

## Decision

**One shared "brain" (pure logic + interface ports), with environment-specific adapters injected by each consumer, running in two execution contexts.**

1. **Whole engine, shared package.** Promote the CLI's full agent engine into a single dependency-light package, `@oxagen/agent-engine` (absorbing the `@oxagen/coding-agent` work-in-progress: `Workspace`, `buildWorkspaceTools`, `MemoryWorkspace`). It contains the loop, the pipeline (evaluate/enhance/route/execute/judge/revise), the model-router, evaluator, judge, planner, fleet scheduler, trace types + formatter, and the system-prompt builder. **It has no platform dependencies** (no `@oxagen/database`, `@oxagen/billing`, Neo4j) so it stays lean and installable; the engine is pure logic, and all environment specifics (AI, recall, sandbox) enter only through injected ports. The rate card currently duplicated in `model-router.ts` moves to a shared pure cost module imported by both the engine and `@oxagen/billing`.

2. **Injected ports (adapters).** The engine depends only on interfaces; each consumer supplies implementations:
   - **`Workspace`** (filesystem): CLI = local `fs`/shell; platform = persistent Vercel Sandbox (ADR-011).
   - **`ModelRunner`** (the AI call): a `streamAgentReply`-shaped function returning a stream + usage. **All AI requests flow through the platform chokepoint — there is no BYOK path** (decided 2026-06-27). The platform injects `streamAgentReply` directly; the CLI injects a thin *authenticated* client that calls a platform streaming-AI endpoint which runs `streamAgentReply` server-side. Every completion — in-app chat, the online coder, and the CLI alike — is metered, permission-gated, and model-routed in one place, for maximum pricing/permission flexibility. The engine **never** hardcodes `streamText`/`streamAgentReply`. Tradeoff: the CLI gains a CLI→platform hop per model call; accepted because model latency dominates and one control surface is the goal.
   - **`CodeGraphProvider`** + **`MemoryProvider`**: **the coding agents ALWAYS read recall/code-graph from a fast LOCAL DuckDB replica — never a synchronous platform call on the turn's critical path** (decided 2026-06-27). The canonical graph syncs to the platform Neo4j **asynchronously** (the ADR-018 graph-sync pattern: local DuckDB replica ⇄ workspace graph). CLI = the user's local DuckDB replica + local FS index (ADR-016); the cloud runner = a colocated replica seeded from the workspace graph. Writes/sync are off the critical path, so recall adds **zero per-turn latency** even though AI completions are centralized.
   - **`TraceStore`**: CLI = local JSON files; platform = ClickHouse (the trace types are already ClickHouse-shaped).

3. **Local + cloud, same engine.** The CLI runs the engine **locally** for the user's working directory (local adapters). For **connected repos** it triggers the **cloud runner**, which runs the *same engine* server-side with sandbox/platform adapters behind `agent.coding.session.*`. The in-app agent invokes that same cloud runner. Two execution contexts, one codebase.

4. **Account-required CLI (no anonymous mode).** The CLI does not function without an Oxagen account — `oxagen login` is mandatory (decided 2026-06-27). Identity is always present, so platform memory, sessions, and connected-repo editing all work, and a run started in the CLI is visible in the app. Because all AI flows through the platform (decision #2), **every run is metered, permission-gated, and priced centrally — local working-dir runs included.** There is no unmetered/BYOK path.

## Consequences

**Positive**
- Exactly one agent behavior. The online agent inherits the CLI's routing, planning, self-judging, and revise loop for free; the CLI inherits the platform's sandbox, connected-repo reach, and shared memory/sessions.
- Every AI call — chat, online coder, CLI — goes through one metered, permission-gated chokepoint, giving maximum flexibility on pricing and access control. Recall stays on a local DuckDB replica (async sync to the platform graph), so this centralization adds no per-turn context latency; only the completion call itself crosses the network.
- The engine stays dependency-light, so the CLI remains installable and fast; platform weight lives only in the platform's adapters (`packages/agent`).

**Negative / risks**
- Migrating the CLI engine into a shared package is more work than the original narrow plan and touches working CLI code (mitigated: the engine is already callback-decoupled; the move is mechanical behind the ports).
- Pipeline parity means the platform coding agent makes the same extra model calls (evaluate/judge/plan) — each metered. This is a deliberate cost-for-quality trade; surface it in pricing.
- Two fan-out mechanisms must reconcile: the engine's fleet scheduler vs the platform's `agent.subagent.dispatch` (ADR-010). The scheduler emits dispatch *intents*; each consumer fulfills them (CLI = local concurrency, platform = Inngest). The engine does not hardcode either.
- Resolved: `runCodingAgent` now takes an injected `AgentAi` port (Task A3, commit `f7d68ed5`) — it no longer hardcodes `streamText`.

## Implementation outline (supersedes the narrow Phase-1 plan)

1. `@oxagen/agent-engine` (pure logic + ports): absorb `Workspace`/tools (done as `@oxagen/coding-agent` Tasks 1–3), add `ModelRunner`/`CodeGraphProvider`/`MemoryProvider`/`TraceStore` ports, migrate pipeline/router/evaluator/judge/planner/fleet/trace from `apps/cli/src/agent`, dedupe the rate card.
2. `apps/cli`: provide local adapters + the BYOK `ModelRunner`; add `oxagen login` (always-linked); keep local execution; add "run in cloud" for connected repos.
3. `packages/agent` (platform adapters): `SandboxWorkspace`, `streamAgentReply` `ModelRunner`, Neo4j `CodeGraphProvider`, `agent.memory` `MemoryProvider`, ClickHouse `TraceStore`.
4. `agent.coding.session.*` contracts + sandboxed Inngest orchestrator wrap the engine for the platform and the cloud runner (clone connected repo → run engine → diff → Phase 2 PR → Phase 3 CI loop).
5. In-app surface + `@`-mention repos (unchanged from the prior plan).
