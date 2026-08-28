---
title: "Two-Axis Memory"
description: "Archived spec & plan — status: shipped (audited 2026-07-03)."
---

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Two-Axis Memory feature has been fully shipped with all core deliverables implemented: Neo4j schema with Citation/Promotion/Evidence nodes and idempotent legacy migration, Postgres workspace_memory_policy table with compliance_threshold and default_decay_floor columns, ClickHouse memory_changes audit table with enforcement tracking, 15+ repository functions in packages/agent/src/memory/neo4j.ts, all 5 new contracts (promote/cite/evidence.attach/promotion.candidates/citations.list), corresponding API routes and MCP tools, CLI commands, and capability documentation. The feature is confirmed on main branch (commit 2ef0e747, PR #357) with follow-up hardening commits through PR #439.

**Implementation evidence**

- packages/ontology/src/schema.cypher — Neo4j constraints, indexes, and idempotent backfill migration for two-axis AgentMemory model
- packages/database/drizzle/0031_workspace_memory_policy.sql — Postgres table creation
- packages/database/atlas/migrations/20260630120000_workspace_memory_policy_two_axis.sql — Postgres columns for compliance_threshold and default_decay_floor
- packages/telemetry/src/migrations/0016_memory_changes.sql and 0017_memory_changes_enforcement.sql — ClickHouse audit table with enforcement tracking
- packages/agent/src/memory/neo4j.ts — Repository functions (recallMemories, promoteMemory, recordCitation, attachEvidence, listPromotionCandidates, listExecutionCitations, etc.)
- packages/oxagen/src/contracts/agent.memory.\{promote,cite,evidence.attach,promotion.candidates,citations.list}.ts — New contracts
- apps/api/src/routes/v1/agent.memory.*.ts — API routes for all new capabilities
- apps/mcp/src/tools/agent.memory.*.ts — MCP tools for all new capabilities
- apps/cli/src/commands/memory.ts — CLI commands including promote and candidates
- docs/capabilities/agent.memory.\{promote,cite,evidence.attach,promotion.candidates,citations.list}.md — User-facing capability documentation
- git log shows commit 2ef0e747 on main: feat(memory): two-axis memory model (OBSERVATION→RULE→FACT, confidence + enforcement) (#357)

**Source documents** (archived verbatim below)

- `docs/specs/two-axis-memory/DESIGN.md`

## Spec — `DESIGN.md`

## Two-Axis Memory Model — Implementation Design

Replaces the flat "gotcha/bug" memory model (`weight` + single `kind` + single
`confidence`) with the two-axis model from the Neo4j memory schema. **The node
label stays `:AgentMemory`** (no relabel/data-loss migration); the schema's
logical `:Memory` maps onto it.

This doc is the contract every layer codes against. Field names in **Neo4j** are
`snake_case` (match the schema); field names in **TypeScript/contracts** are
`camelCase`.

### Two axes, two weights

- `memory_class` — epistemic status: `OBSERVATION` → `RULE` → `FACT`.
- `memory_kind` — content domain (extensible **open string**). Canonical set:
  `FEEDBACK`, `PERFORMANCE`, `STYLE`, `PREFERENCE`, `VOICE`, `PROSE`, plus the
  retained engineering kinds `routine-change`, `constraint`, `bug-root-cause`,
  `convention-deviation`, `gotcha` (kept so existing memories/classifier stay
  valid). Stored verbatim; not a closed enum.
- `confidence_score` — FLOAT 0–100. Evidence measure. **Auto-decays**, recovers
  on evidence. (Legacy `confidence` was 0–1; migrate ×100.)
- `enforcement_score` — INT 1–100. Policy. **No auto-decay.** `null` for
  OBSERVATION; forced `100` for FACT.

### `:AgentMemory` node properties (graph snake_case → TS camelCase)

Kept infra props: `id`, `publicId`, `orgId`, `workspaceId`, `nodeRef`, `label`,
`displayName`, `is_system`, `embedding`, `createdAt`, `updatedAt`.

Kept content prop: `lesson` (≡ schema `body`; **not renamed** — pure churn, no
functional gain. TS field stays `lesson`).

New / changed:

| Neo4j prop | TS field | Type | Notes |
|---|---|---|---|
| `memory_class` | `memoryClass` | `OBSERVATION\|RULE\|FACT` | NEW |
| `memory_kind` | `memoryKind` | open string | replaces `kind` |
| `confidence_score` | `confidenceScore` | float 0–100 | replaces `confidence` (×100) |
| `enforcement_score` | `enforcementScore` | int 1–100 \\| null | NEW |
| `half_life_days` | `halfLifeDays` | float | NEW, default by class |
| `decay_floor` | `decayFloor` | float | NEW, default 5 |
| `last_evidence_at` | `lastEvidenceAt` | datetime | NEW, decay clock; seeded from `lastReinforcedAt` |
| `citation_count` | `citationCount` | int | NEW, default 0 |
| `influence_count` | `influenceCount` | int | NEW, default 0 |
| `violation_count` | `violationCount` | int | NEW, default 0 |
| `created_by_kind` | `createdByKind` | `AGENT\|USER\|SYSTEM` | NEW, from `source` |
| `created_by_id` | `createdById` | string \\| null | NEW |
| `confirmed_by_kind` | `confirmedByKind` | `USER\|AGENT\|SYSTEM` \\| null | NEW; FACT requires `USER` |
| `confirmed_by_id` | `confirmedById` | string \\| null | NEW |
| `status` | `status` | `ACTIVE\|SUPERSEDED\|RETRACTED\|ARCHIVED` | NEW, default ACTIVE |
| `subject_hint` | `subjectHint` | string | NEW, denormalized primary :ABOUT label; seed from `nodeRef` |

`weight` (legacy `low|high|critical`) is **dropped** from the primary model but
kept present on legacy nodes for the migration window; it is no longer read by
recall/list/decay.

#### Invariants (enforced in the app/handler layer)
- `memory_class = FACT` ⟹ `confirmed_by_kind = USER` AND `enforcement_score = 100`.
- `memory_class = OBSERVATION` ⟹ `enforcement_score IS NULL`.
- `memory_class = RULE` ⟹ `enforcement_score BETWEEN 1 AND 100`.
- `confidence_score BETWEEN 0 AND 100`.

#### Half-life defaults (write time)
- FACT → `36500` (effectively infinite).
- RULE → workspace `halfLifeHighDays` (default 90).
- OBSERVATION → workspace `halfLifeLowDays` (default 30).
- `decay_floor` default 5 (workspace `defaultDecayFloor`).

### New graph nodes + edges

- `:Citation {id, retrieved_at, influence, compliance, enforcement_at_cite, confidence_at_cite, expected_value, observed_value, agent_rationale}`
- `:Execution` (already exists) `-[:CITED]->(:Citation)-[:OF]->(:AgentMemory)`
- `:Promotion {id, from_class, to_class, promoted_by_kind, promoted_by_id, enforcement_score_set, rationale, created_at}` `-[:PROMOTED]->(:AgentMemory)`, `-[:BASED_ON]->(:Evidence)`, `-[:REVERSED_BY]->(:Promotion)`
- `:Evidence {id, source_kind, strength, detail, created_at}` `-[:SUPPORTS]->` / `-[:REFUTES]->(:AgentMemory)`
- `(:AgentMemory)-[:ABOUT {role, weight}]->(subject)` (role `PRIMARY|CONTEXT`)
- `(:AgentMemory)-[:SUPERSEDES]->(:AgentMemory)`
- `(:AgentMemory)-[:CONTRADICTS {detected_at, resolved}]->(:AgentMemory)`

Constraints/indexes (schema.cypher): unique `publicId` (or `id`) for
`:Citation`/`:Promotion`/`:Evidence`; org indexes; index on
`(:AgentMemory) memory_class, memory_kind` and `status` and
`(memory_class, citation_count)` for promotion pressure.

### Enums (shared)
- `influence`: `DECISIVE | CONTRIBUTING | CONSIDERED | IGNORED`
- `compliance`: `COMPLIED | DISCRETION | VIOLATION | NA`
- `evidence.sourceKind`: `CITATION | HUMAN_CONFIRM | CODE_SCAN | AGENT_JUDGE | REPEAT_OBSERVATION`
- `complianceThreshold`: workspace policy knob, default 70.

Compliance derivation: `E` = enforcement at cite.
- not a RULE / `E` null → `NA`
- no deviation → `COMPLIED`
- deviation AND `E < threshold` → `DISCRETION`
- deviation AND `E >= threshold` → `VIOLATION`

### Repository (`packages/agent/src/memory/neo4j.ts`) function surface

Updated (new projection incl. all new fields; `status = 'ACTIVE'` filter on
reads): `recallMemories`, `listMemories`, `writeMemory`, `updateMemory`,
`getMemoryById`, `listDecayableMemories`, `applyDecayToMemory`.

`recallMemories`/`listMemories` new optional filters: `memoryClass?`,
`minEnforcement?`; drop `minWeight`. Recall confidence gate compares
`confidence_score/100 >= recallThreshold` (policy stays 0–1).

`reinforceMemory` → generalized by `attachEvidence`.

New:
- `promoteMemory({memoryId, toClass, enforcementScore?, promotedByKind, promotedById, rationale, basedOnEvidenceIds?})`
- `listPromotionCandidates({limit})` (schema §7c)
- `recordExecution({executionRef, agentId, runId, taskSummary})` → MERGE `:Execution` by `id`
- `recordCitation({executionId, memoryId, influence, compliance, enforcementAtCite, confidenceAtCite, expectedValue?, observedValue?, agentRationale?})` → `:Citation` + counter maintenance (§7f)
- `attachEvidence({memoryId, sourceKind, strength, detail, refutes?})` → `:Evidence` + confidence recovery/reduction (§7b)
- `listExecutionCitations({executionId, compliance?, influenceIn?})` (§7d/§7e)

Decay (§7a): `new_conf = floor + (conf - floor) * 0.5^(days_since/half_life)`
using `last_evidence_at`; skip FACT and `status != ACTIVE`.

### Postgres `workspace_memory_policy` — add columns
- `compliance_threshold` int NOT NULL default 70
- `default_decay_floor` real NOT NULL default 5
Keep `half_life_low_days` (OBSERVATION default), `half_life_high_days` (RULE
default), `recall_threshold` (0–1).

### ClickHouse `memory_changes` — add columns
- `enforcement_before` Float32 default 0, `enforcement_after` Float32 default 0
- extend `cause` LowCardinality values: add `promoted`, `evidence`, `cited`, `violation`.

### New contracts (domain `agent`, category `memory`)
- `agent.memory.promote`
- `agent.memory.promotion.candidates`
- `agent.memory.cite`
- `agent.memory.evidence.attach`
- `agent.memory.citations.list` (execution citations; supports compliance/influence filters → covers §7d/§7e)

Each: contract → API route → MCP tool → CLI command → docs → tests.

### Legacy → new migration (idempotent, in schema.cypher migration block)
For every `:AgentMemory` missing `memory_class`:
- `confidence_score = coalesce(confidence,1.0)*100`
- `weight = 'critical'` → `memory_class='RULE'`, `enforcement_score=95`
- `weight = 'high'` → `memory_class='RULE'`, `enforcement_score=70`
- `weight = 'low'`/other → `memory_class='OBSERVATION'`, `enforcement_score=null`
- `memory_kind = coalesce(kind, 'constraint')`
- `half_life_days` per class defaults; `decay_floor = 5`
- `last_evidence_at = coalesce(lastReinforcedAt, createdAt)`
- counters = 0; `status = 'ACTIVE'`
- `created_by_kind` from `source` (`user`→USER, `feature`/`fix`→AGENT, else SYSTEM); `created_by_id = source`
- `subject_hint = coalesce(nodeRef, '')`

