# Stella ⇄ Oxagen Graph — Memory, Execution Lineage & Business-Process Binding

**Status:** Superseded — all workspace-graph synchronization directions are obsolete · **Owner:** Mac Anderson · **Surface:** `apps/cli` (Stella) + `packages/engram` + `packages/oxagen` contracts + Neo4j ontology
**Related:** ADR-018 (superseded), `docs/specs/workspace-graph-boundary/spec.md`, [[connector-dual-write-pattern]], [[graph-node-anchor-and-is-system-model]], [[cli-claude-code-parity-stack]]

> **Do not build the up-sync plan in this document.** The workspace-graph
> boundary supersedes every proposal here that uploads Stella's checkout graph,
> writes exact file/symbol lineage into the workspace graph, or rides
> `graph.sync.push`. The former cloud→CLI path is also retired: graph export,
> CLI pull/status, and the local workspace DuckDB projection cannot guarantee
> tombstone, deletion, or authorization-revocation convergence. Stella owns its
> exact local graph and memory; shared Oxagen context is retrieved online through
> the current authorization boundary. Oxagen's workspace graph may accept
> verified canonical domain/code-scope projections. A future
> `RunEvidenceManifestV1` path may carry governed run evidence, but no such
> ingest implementation is defined here. Memory lifecycle and rule-adherence
> ideas may be reconsidered separately.

---

## 0. One-paragraph thesis

Stella's exact code graph and Oxagen's governed workspace context are complementary, not one graph to synchronize. Stella follows the bytes in the active checkout; Oxagen retains the business ontology, stable canonical domain/code-scope topology, governed context, and enterprise policy. The intended bridge is immutable, attributable run evidence that can support coarse business impact without centrally copying branch-local files and symbols. This document's memory and rule-adherence ideas remain useful product intent, but its generic graph-up-sync mechanism and exact file-lineage projection are superseded.

---

## 1. Current state (ground truth — do not re-invent)

### 1.1 The substrate already exists: `@oxagen/engram`

`packages/engram` is a mature memory substrate. It is **the standard Oxagen memory format** and it is already a CLI dependency.

| Capability | Where | What it gives us |
|---|---|---|
| Record format | `engram/src/types.ts` | Content-addressed (`blake3`) records: `episodic \| semantic \| procedural \| entity \| edge`, with `salience`, `confidence`, `provenance{author,derivedFrom,tool,model}`, `causality[]`, `namespace{org,workspace,session,agent}`, optional `embedding`, `ttl`. |
| Write API | `engram/src/api/*` + `createEngram(store)` | `remember(episodic)`, `assert(fact, confidence)`, `pin(rule)` / `unpin`, `relate(src,edge,tgt)`. |
| Consolidation | `engram/src/consolidation/*` | `distill()` clusters episodics → semantic facts; `detectPatterns()`+`promotePatterns()` turn repeated successful tool sequences → procedural rules; `deduplicateSemanticRecords()`. |
| Sync (offline-first) | `engram/src/sync/*` | **Full CRDT sync**: `VectorClock`, `ORSet`, `PNCounter`, Merkle-tree diff, `prioritizeForSync`, `batchByPriority`, `syncWithPeer(SyncRequest→SyncResponse)`. |
| Cloud projection | Retired | Engram remains local. Shared memory must be promoted through an explicit, typed, IAM-governed path rather than hidden graph-sync/embed fan-out. |
| Legacy migration | `engram/src/migration/neo4j-to-engram.ts` | Gen-1 `:AgentMemory` → Gen-2 engram records (`WEIGHT_TO_SALIENCE`). |
| Decay / reinforcement | `engram/src/{decay,reinforcement,salience}.ts` | Half-life salience decay, reinforcement on re-use. |

### 1.2 What Stella records **today** (all local, mostly un-synced)

| Data | File | Store | Synced up? |
|---|---|---|---|
| Fleet lessons (weighted JSONL) | `apps/cli/src/agent/fleet/memory.ts` | `~/.config/oxagen/memories/<proj>.jsonl` | ❌ (planned to promote to `agent.memory.write`) |
| Episodic session memory | `apps/cli/src/agent/memory.ts` → engram | `~/.config/oxagen/context.duckdb` | ❌ |
| Turn traces (eval/enhance/route/execute/judge, tokens, cost, tool events) | `apps/cli/src/agent/trace*.ts` | `~/.config/oxagen/traces/<proj>.json` | ❌ |
| Local code graph | `apps/cli/src/daemon/code-graph/store.ts` | checkout-local DuckDB | ❌ (stays local) |
| **Workspace graph projection** | historical `apps/cli/src/commands/graph.pull.ts` | historical `~/.config/oxagen/graph/<ws>.duckdb` | **Retired:** no export, pull/status, cursor, or workspace replica |

**Takeaway:** Stella uses local code and memory stores. It does not keep a workspace-graph replica. Shared context is read through scoped online capabilities, while memory federation, execution evidence, and code/process bindings each require a separately governed design consistent with the workspace-graph boundary.

### 1.3 Historical platform graph model (superseded for code/run evidence)

The inventory below describes the pre-boundary model. Its `SourceFile`,
`SourceSymbol`, and execution-edge shapes are not approved as the launch upload
target for Stella checkout detail.

- Universal anchor `(:GraphNode:<Label>)` with `publicId`, `displayName`, `properties`, `is_system`, optional `embedding float[1536]`; `graph_node_embedding_index` powers NL search via `graph.search` (kinds: `entity·file·symbol·chunk·memory·execution·document·message·asset`). Cite nodes by `knowledgeNodeRef{id,label,displayName,properties}`, **never raw UUID** ([[ui-node-edge-citation-rule]]).
- Memory (Gen-1): `agent.memory.write/recall/policy.*` → `(:AgentMemory)` with `REMEMBERS`/`ABOUT` edges, vector recall, half-life decay.
- Executions: Postgres `agent_executions` (status, tokens, cost, `parent_execution_id`, `synced_to_graph_at`) projected to `(:Execution)` with `INVOKED`/`ORIGINATED_FROM`/`CALLED_TOOL` edges (`packages/ontology/src/mutations/record-execution.ts`).
- Business ontology: customer entities are `(:<Type>:EntityNode)` keyed by `naturalKey="{connector}:{conn}:{externalId}"`, `entityType` property, multi-label via `graph.node.label.add/remove`. Code is `(:SourceFile)/(:SourceSymbol)/(:SourceChunk)`; `(:Feature)-[:IMPLEMENTS]->(:SourceFile|:SourceSymbol)` is inferred today.

### 1.4 Original greenfield gaps (historical)

1. **Memory up-sync** — Stella's engram records (episodic/semantic/procedural) never reach the cloud graph. *(Build on ADR-018 + engram `sync/`.)*
2. **Execution-as-lineage with code + process binding** — no `(:Execution)-[:MODIFIED]->(:SourceFile|:Feature)` and no `(:Execution)-[:SERVED]->(business process/entity)`. The agent runs but the graph never learns *what code it changed* or *what the business it served*.
3. **Rule adherence** — nothing retrieves the workspace's rules/facts before a turn, enforces them during tool use, or records violations. Memory is written but never *obeyed*.

---

## 2. Highest-value data to record

Two streams: **executions** (what happened) and **memories** (what we learned). Record by value, not by volume — every record costs sync bandwidth, graph size, and recall noise.

### 2.1 Executions → graph (historical proposal; superseded)

One `(:Execution)` per Stella turn/fleet-task, written **after** the turn (we know the outcome). Priority = highest first.

| # | Datum | Edge / property | Why it's the highest value |
|---|---|---|---|
| 1 | **What code changed** | `(:Execution)-[:MODIFIED {hunk,linesAdded,linesRemoved}]->(:SourceFile)` | Turns every run into reviewable, queryable lineage. Enables blast-radius, audit, and the business binding below. |
| 2 | **What business process/feature it served** | `(:Execution)-[:SERVED {confidence}]->(:Feature\|:EntityNode)` | The moat. Connects "code written" to "business value." Greenfield. |
| 3 | **Outcome + verification** | props `{status, judgeComplete, testsPassed, buildPassed}` | Distinguishes a *successful* pattern (promotable) from a failed one. |
| 4 | **Cost/latency/model/tier** | props `{inputTokens,outputTokens,estimatedCostUsd,latencyMs,model,tier}` | Already captured in `TurnTrace`; feeds `oxagen cost`, fleet economics, model-routing learning. |
| 5 | **Tools called** | `(:Execution)-[:CALLED_TOOL]->(:Tool)` (existing) + per-MCP-tool | Capability usage, security audit (what did the agent touch). |
| 6 | **Lineage** | `(:Execution)-[:DERIVED_FROM]->(:Execution)` (subagent/revision parent) | Reconstruct fleet/plan trees; `parent_execution_id` already exists. |
| 7 | **Prompt + plan provenance** | `(:Execution)-[:ORIGINATED_FROM]->(:Conversation\|:Plan)` | Why the run happened; ties to the planner's task. |

Raw per-event firehose (every token, every keystroke) stays in **ClickHouse** (append-only telemetry), **not** the graph — the graph gets the distilled `:Execution` node + edges. This respects the four-store boundary.

### 2.2 Memories → graph (the learning stream)

| Kind | Engram API | Example a coding agent should write | Recall value |
|---|---|---|---|
| **Episodic** (an observation; `confidence=1.0`) | `remember({event,payload,outcome})` | "Ran `pnpm --filter @oxagen/billing test:unit grants.test.ts` → green." / "User rejected the migration approach." | Raw material for distillation; provenance trail. |
| **Semantic** (a distilled fact; `confidence∈[0,1]`) | `assert(fact, confidence)` | "`apps/api` loads its own `.env.local`, not root." / "RLS requires the `oxagen_app` role." | The "facts" the agent should know — exactly the things in this repo's `CLAUDE.md` and the memory index, but **learned and graph-anchored.** |
| **Procedural** (a rule/playbook; success-tracked) | `pin({rule,appliesTo,successCount,failureCount})` | "When editing a migration: never edit an applied one — add a forward migration." / "Before a billing change, assert the role gate." | The rules the agent must **obey** (§4). |
| **Entity / Edge** | `assert`/`relate` | Link a new module to the `:Feature` it implements. | Grows the graph from inside the coding loop. |

**The killer alignment:** this repo's `CLAUDE.md` + `MEMORY.md` are *hand-maintained semantic+procedural memory*. This spec makes Stella **generate and obey the same thing automatically, per workspace, graph-anchored, and shareable** — the manual memory file becomes the bootstrap seed, not the ceiling.

---

## 3. Observation → Memory → Fact: what gets stored, and what gets promoted

Engram already encodes this lifecycle. Stella must *use* it deliberately. The gates below prevent the #1 failure of agent memory: **noise** (storing everything → recall returns garbage → agent ignores memory).

```
   tool result / user msg / judge verdict
                │
                ▼
        ┌───────────────┐   keep only if "decision-relevant" (§3.1)
        │  EPISODIC      │   remember(): confidence 1.0, ttl ~30–90d, decays
        └───────┬───────┘
                │   distill(): cluster ≥N related episodics across runs
                ▼
        ┌───────────────┐   assert(): confidence = cluster agreement
        │  SEMANTIC FACT │   supersedes[] older contradicting facts
        └───────┬───────┘
                │   promotePatterns(): repeated successful procedure
                ▼   (DEFAULT_PROMOTION_CONFIG: ≥80% success, ≥5 occurrences,
        ┌───────────────┐    not already covered by an existing rule)
        │  PROCEDURAL    │   pin(): a RULE — retrieved + enforced every run (§4)
        │  RULE / FACT   │
        └───────────────┘
```

### 3.1 What becomes an episodic (the noise filter)

Write an episodic **only if it could change a future decision.** Concretely, Stella records:

- ✅ A **verification outcome** (test/build/lint ran and its result) — feeds rule success/failure counts.
- ✅ A **surprise**: a tool result that contradicted the agent's expectation, an error + its root cause, a path/config that wasn't where expected.
- ✅ A **human signal**: the user corrected, rejected, or confirmed an approach (high salience).
- ✅ A **convention observed**: "this package uses `.js` import extensions," "tests live in `__tests__`."
- ❌ **Not** stored: every file read, every successful no-op tool call, restating the prompt, intermediate reasoning, anything already a high-confidence fact (would just duplicate).

Salience at write time (`computeSalience`) is boosted by: human-originated, failure outcome, security/billing/auth domain, breadth of files. Low-salience episodics decay out within the TTL and never get synced (sync prioritization, §5.3).

### 3.2 What gets promoted to a fact / rule (and what doesn't)

- **Episodic → semantic fact** (`distill`): only when ≥N (config) episodics across **different runs** agree on a generalization, *and* it isn't already asserted. A one-off is never a fact. Contradictions bump `supersedes[]` and lower confidence rather than spawning a duplicate.
- **Semantic/episodic → procedural rule** (`promotePatterns`, `DEFAULT_PROMOTION_CONFIG`): a tool/action **sequence** that succeeded **≥80% over ≥5 occurrences** becomes a pinned rule. Below threshold it stays a fact (advice), not a rule (enforced).
- **Demotion / decay:** a rule whose live success rate drops (violations + failures, §4.4) loses confidence and, past a floor, is auto-unpinned — rules that stop working stop being enforced. This is what hand-maintained `CLAUDE.md` can't do.

### 3.3 Authority tiers (which memory wins)

When memories conflict, precedence is: **workspace policy / human-pinned rule** > **org-curated fact** > **distilled procedural rule** > **semantic fact** > **episodic**. Human-authored (incl. the seed `CLAUDE.md`) and explicitly-pinned rules are `is_system`/locked and never auto-demoted.

---

## 4. Rule adherence — making Stella *obey*, and proving it didn't violate

Recording rules is worthless if the agent ignores them. This is the part competitors don't have and the part that reuses the gate Stella **already shipped** ([[cli-claude-code-parity-stack]]: `apps/cli/src/settings/` permission gate + hooks). Three enforcement tiers, defense-in-depth:

### 4.1 Tier 1 — Retrieve + inject (soft, every turn)

Before a turn, retrieve the **active rule set** for this context and inject it into the system prompt (a dedicated, cache-stable section):

- Procedural rules (`pin`) whose `appliesTo` matches the turn's files/domain/intent, ranked by confidence.
- High-confidence semantic facts relevant to the touched files (vector recall via `agent.memory.recall` / `graph.search kinds=[memory]`, scoped to the files' `:Feature`/domain).
- Workspace policies (`agent.memory.policy.read`).

Retrieval starts from Stella-local memory and the checkout-local code graph. Shared cloud context, when explicitly authorized for the turn, is fetched through a bounded online capability; there is no bulk workspace replica or offline cloud-context fallback. The `recallContext()` seam can still evolve from "recent episodics" to applicable local rules and facts.

### 4.2 Tier 2 — Gate (hard, per tool call)

This is the teeth. Stella's `PreToolUse` hook + permission gate (already built) is extended with a **rule check**: when the model proposes a tool call, evaluate it against active **deny-shaped** rules before it runs.

- A procedural rule can carry a machine-checkable guard, e.g. `{ rule: "never edit an applied migration", guard: { tool: "edit_file", denyPathGlob: "packages/database/migrations/*-applied/**" } }`.
- The gate (reusing `evaluateLocalPermission` + the hooks runner) **blocks** the call and returns the rule text to the model ("⛔ blocked by rule: add a forward migration instead"), so the agent self-corrects mid-turn instead of shipping a violation.
- Rules without a machine guard fall back to Tier 1 (prompt) + Tier 3 (judge).

This means **rules are enforced by the same mechanism as permissions and MCP tool gating** — one coherent guard surface, not a second system.

### 4.3 Tier 3 — Verify + attest (post-hoc judge)

The existing completeness **judge** is extended to a **compliance judge**: given the diff + the active rule set, it returns `{ violated: ruleId[], evidence }`. On a violation:

- The turn is marked non-compliant; in fleet/isolation mode the work can be held (not merged) pending the fix, reusing the worktree-integration gate.
- A **negative episodic** is recorded against the violated rule (`outcome:"failure"`, `causality→ruleId`), which lowers the rule's success rate (§3.2 demotion) **and** is the audit artifact ("Stella violated rule X here, caught, corrected").

### 4.4 The adherence flywheel

Tier-2 blocks and Tier-3 catches both feed `successCount`/`failureCount` back into the rule. Rules that keep working get reinforced and rise in recall; rules that misfire decay and unpin. **The guardrail tunes itself from real outcomes** — no human re-curation. This is the answer to "ensure agents adhere and don't violate": *retrieve → gate → verify → score → decay,* on the same substrate that records the memory.

---

## 5. Sync architecture (CLI ⇄ cloud)

### 5.1 Both synchronization directions are retired

- **Down (cloud→CLI): retired.** No graph export, pull/status command, cursor, or local workspace projection. Bulk dumps cannot converge safely for tombstones, deletion, and grant revocation.
- **Up (CLI→cloud): retired.** Do not use generic graph mutation for execution, code lineage, or memory. Any future memory federation or `RunEvidenceManifestV1` ingest needs a narrow authenticated contract, explicit authority, retention, and verification semantics outside this obsolete transport plan.

### 5.2 What syncs where

| Stream | Local write | Up-sync transport | Cloud landing |
|---|---|---|---|
| Memories (episodic/semantic/procedural) | engram store (DuckDB) | **Not specified here.** The former CRDT peer/up-sync proposal requires a new governed design. | No new landing is approved by this spec. |
| Executions + code lineage | local trace/evidence sources | **Retired:** no `graph.sync.push`. A future narrow evidence-manifest ingest is a separate design. | Evidence ledger first; any coarse workspace projection must be derived and verified. |
| Raw telemetry | (already) | existing telemetry ingestion | ClickHouse |

### 5.3 Historical offline-first proposal (superseded)

The CLI must still work offline for checkout-local code and Stella-local memory. This document does not authorize a background workspace-graph reconcile. The former prioritized CRDT proposal is retained as research for a future memory-federation spec, not as a graph-sync launch path.

### 5.4 Tenancy + privacy

Namespaces (`{org,workspace,session,agent}`) scope local records. Any future federation contract must enforce organization/workspace scope server-side and define deletion, revocation, retention, and redaction semantics. Secrets and credentials are **never** stored as memory content.

---

## 6. Historical graph-binding proposal (superseded)

This is the section competitors structurally cannot copy, because they have no business ontology.

### 6.1 The new edges (greenfield)

```cypher
(:Execution)-[:MODIFIED   {hunk, linesAdded, linesRemoved, contentHash}]->(:SourceFile)
(:Execution)-[:SERVED     {confidence, rationale}]->(:Feature)        // or :EntityNode (a process)
(:Execution)-[:DERIVED_FROM]->(:Execution)                            // fleet/revision lineage
```

`SERVED` is resolved by joining what Stella `MODIFIED` to the existing `(:Feature)-[:IMPLEMENTS]->(:SourceFile)` edges (already inferred from the code+connector graph). So: **Stella edits `billing/grants.ts` → `MODIFIED`→ that file → which `IMPLEMENTS`← the `:Feature{Billing Grants}` → which the connector graph ties to the `:EntityNode{Subscription}` business object.** The chain *code change → feature → business process* is computed, not guessed.

### 6.2 What this unlocks (the "cool things")

1. **Process-aware impact analysis, pre-merge.** Before Stella opens a PR: "this change touches code implementing the **Invoicing** and **Dunning** processes; 3 automations and the `month-end-close` workflow depend on it." Reviewers see business blast-radius, not just file diffs.
2. **Process-scoped planning & retrieval.** A goal like "speed up checkout" resolves to the `:Checkout` process → its `IMPLEMENTS` code + its past `:Execution`s + the rules learned on it. The planner ([[cli-agent-fleet-subsystem]]) seeds tasks and **assigns the right named agent** ([[cli-claude-code-parity-stack]]) from real process context, not a grep.
3. **Compliance & audit by business meaning.** "Show every Stella execution that modified code serving a **SOC2-relevant** or **PII-touching** process in the last 90 days, with the rules it obeyed/violated." That's a one-hop graph query feeding the SOC2 evidence story ([[soc2-blocker-backlog]]) — auto-generated change-management evidence.
4. **Business-process regression targeting.** When code for the **Payments** process changes, select exactly the tests/e2e tied to that process (via `IMPLEMENTS`/`PART_OF`), instead of running everything — money-path tests first ([[testing-philosophy-hybrid-agent-e2e]]).
5. **Cross-repo, cross-agent learning bound to the business.** A rule learned while editing Payments in repo A applies when any agent edits Payments code in repo B, because the rule's `appliesTo` is the **process/feature**, not a path. No competitor's per-repo memory can do this.
6. **"Explain this code" in business terms.** Hover a file → "implements the **refund** step of the **Returns** process; last changed by execution E (served Returns, tests green); 2 rules apply here." The `knowledgeNodeRef` citation UX already exists for this.
7. **ROI & drift reporting.** Per business process: agent executions, cost, success rate, rules, open violations. Leadership sees "engineering effort per business capability" — derived, not surveyed.

### 6.3 Why this beats every competitor (summary)

| | Cursor / Copilot / Claude Code / Cody | **Stella + Oxagen** |
|---|---|---|
| Memory scope | per-repo, per-user, flat text | org-wide, portable, graph-anchored, confidence-decayed |
| Cross-session learning | none / shallow | episodic→semantic→procedural with promotion + decay |
| Rule enforcement | prompt-only ("please follow") | retrieve → **gate (hard block)** → verify → score → decay |
| Knows what code is *for* | no | code ⇄ `:Feature` ⇄ business process, from real systems |
| Execution lineage | ephemeral chat log | first-class `:Execution` graph nodes bound to business value |
| Audit/compliance | none | business-meaning queries → SOC2/change-mgmt evidence |
| Multi-agent dedupe | n/a | CRDT sync (vector clocks/OR-sets), no coordinator |

---

## 7. Contracts & surfaces (capability-parity: contract → API → MCP → CLI)

> **Historical, non-normative inventory.** The proposed execution/link/lineage
> capabilities below are not approved launch surfaces. They must be redesigned
> around the workspace-graph and evidence-ledger boundary before implementation.

New/changed capabilities (each gets a contract in `packages/oxagen/src/contracts/`, an API route, an MCP tool, and CLI wiring — [[no-drift-across-surfaces]]):

| Capability | Purpose | Notes |
|---|---|---|
| `agent.memory.write` *(exists)* | write a semantic/procedural memory | CLI starts calling it via engram `assert`/`pin` |
| `agent.memory.recall` *(exists)* | retrieve applicable facts/rules | Tier-1 retrieval; add `appliesTo`/domain filter |
| `agent.memory.sync` **(new)** | engram CRDT peer endpoint (Merkle diff in/out) | the up-sync "peer"; wraps engram `syncWithPeer` server-side |
| `execution.record` **(new)** | persist a Stella `:Execution` + props | distilled from `TurnTrace`; Postgres + Neo4j projection |
| `execution.link` **(new)** | attach `MODIFIED`/`SERVED`/`DERIVED_FROM` edges | code+process binding; `SERVED` may be inferred async |
| `process.executions.list` **(new)** | "what executions served process X" | the moat query; rides `ontology.query` |
| `execution.lineage.get` **(new)** | traverse execution→file→feature→process | impact analysis surface |

CLI: extend `runAgent`/the pipeline to write engram records + queue an execution; add `oxagen memory list/show/sync`, `oxagen exec list/show`, and surface rule blocks in the REPL. Reuse the settings permission gate + hooks for Tier-2.

---

## 8. Phased delivery (coordinate with ADR-018)

- **Phase 0 — Superseded.** Retire both ADR-018 directions: no graph export, pull/status, workspace replica, or generic graph mutation transport.
- **Phase 1 — Memory write + sync.** Wire the CLI agent loop to engram `remember/assert/pin` with the §3.1 noise filter; stand up `agent.memory.sync` (engram CRDT peer) and up-sync memories. *Verification:* write a fact in the CLI, see it in `graph.search kinds=[memory]` in the web app.
- **Phase 2 — Execution lineage.** `execution.record` + `MODIFIED` edges from the turn's `filesTouched`. *Verification:* run Stella on a file, query `execution.lineage.get`, see the `:Execution`→`:SourceFile` edge.
- **Phase 3 — Business binding.** `SERVED` inference (join `MODIFIED` × `IMPLEMENTS`), `process.executions.list`, impact-analysis surface. *Verification:* edit billing code → "served the Billing process" in the PR/UI.
- **Phase 4 — Adherence loop.** Tier-1 rule retrieval into the prompt, Tier-2 machine-guard gate (reuse permission gate), Tier-3 compliance judge + violation episodics + decay. *Verification:* pin a "no edits to applied migrations" rule, watch the gate block a violating edit and the judge attest compliance.
- **Phase 5 — Consolidation & ROI.** Scheduled `distill`/`promotePatterns` (Inngest), rule demotion/decay, per-process ROI reporting.

Phases 1–5 are retained as historical product intent, not an executable plan. They require a replacement spec that preserves Stella-local code detail, a canonical-ref-only workspace projection, and a separately authorized evidence ledger.

---

## 9. Risks & open decisions

- **Recall noise is the existential risk.** If memory recall returns junk, the agent learns to ignore it and the whole flywheel dies. Mitigation: aggressive §3.1 filter, confidence/salience thresholds on recall, decay, dedupe. Treat recall precision as the headline metric.
- **`SERVED` confidence.** Inferred process binding will be imperfect. Do not ship it through the retired semantic-edge family. A replacement candidate model must preserve evidence and provenance, require explicit authorized approval, and support invalidation before any binding becomes load-bearing for audit.
- **Privacy of code as memory.** Never sync secret-bearing payloads; redact episodic payloads; memories are customer-owned and deletable (GDPR erase path already exists).
- **Open:** (a) machine-guard rule DSL — start with the permission-rule syntax already shipped (`Tool(glob)`), extend only as needed. (b) Decay constants for procedural rules (separate from the memory half-life policy). (c) The authoritative typed evidence-ledger store and projection model. (d) A separate memory-federation contract with explicit lifecycle, authority, and erasure semantics.

---

## 10. Acceptance (definition of done for the vision)

A developer runs `oxagen "add a refund cap to the returns flow"` in repo A. Stella: retrieves the rules learned on the **Returns** process (incl. ones first learned in repo B), is **blocked** by the gate from editing an applied migration and self-corrects, opens a PR that says *"modifies code serving the Returns process; 2 dependent automations; all Returns money-path tests green; obeyed 4 rules, 0 violations,"* and — back in the web app — a teammate sees that execution on the **Returns** process node, the new fact Stella learned, and the rule that now applies workspace-wide. No other coding agent on the market can produce that sentence.
