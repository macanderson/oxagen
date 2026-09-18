# ADR-093: One assembler decides what reaches the agent, and records what it cut

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform
- **Decided by:** the maintainer, 2026-09-18, approving the architecture review
  of the same date in full
- **Related:** ADR-091 (Phase 0, the first prefix), ADR-097 (the two planes and
  the precedence rule), ADR-094 (the gateway, injection point five), ADR-051
  (volatile policy), ADR-061 (steering governance), ADR-090 (skill resolution),
  ADR-008 (skills, amended), ADR-035 and ADR-036 (the Context Graph Protocol
  types `packWithinBudget` uses), ADR-003 and ADR-087 (Neo4j), the Mission
  Control spec sections "Steering" (§10) and "The knowledge graph" (§9)
- **Delivered by:** Phase 0 (ADR-091, in review as PR #3289), Phase 1 (the type,
  the assembler, the manifest), Phase 3 (the graph index), Phase 4 (per-turn
  injection at the proxy)

## Context

Checked at `main` `02278c913`.

- Nothing assembles steering. ADR-091 compiles `must` and `should` records into
  the bundle's `context.system`, and it is in review, not on `main`.
- The only token budgeter in the tree is `packWithinBudget`
  (`packages/context-provider/src/budget.ts:37`). It packs Context Graph
  Protocol frames best-first under a frame and token limit and reports what it
  dropped.
- The review called `packages/engram` and `packages/context-provider` dead.
  More exactly: no application imports either. `@oxagen/context-provider` is
  named only by the env registry (`packages/config/src/registry.ts`).
  `@oxagen/engram` is imported by `packages/context-provider`, declared by
  `tools/scripts/package.json`, and listed in `apps/app/next.config.ts`, and no
  app, handler or function calls it. So there are two memory systems (engram on
  DuckDB, `:AgentMemory` on Neo4j) and only the second is read by a product
  surface.
- Memory reaches only the in-app agent, capped at 6
  (`packages/agent/src/runtime/assistant-recall.ts`, `RECALL_LIMIT`).
- Two paths write `agent.context_records`: `merge_context_pr`
  (`packages/handlers/src/context.pr.merge.ts`) and
  `publish_context_record` (`packages/handlers/src/context.record.publish.ts`).
  The schema comment says the second leaves `kind`, `force`,
  `constraint_effect` and `statement` NULL, so ordering by force is undefined
  for those rows, and ADR-091's compiler cannot see them.
- There is no `:Record` label anywhere in `packages/ontology` or
  `packages/ingestion`. The graph holds no steering.
- `UserPromptSubmit` is handled by the collector and is not used for steering.
  It is the only hook that receives the prompt.

## Decision

### 1. One assembler

What must be single is the assembler: `assembleSteering(run, budget)`, the one
function where everything competes for Oxagen's slice of the agent's context.
It returns three things:

- a **stable prefix**: `must` and `should` items, cached in the signed bundle,
  works offline;
- a **volatile selection**: `may` and `info` items picked per prompt under a
  token budget;
- a **manifest** of what was rendered and what was cut, recorded as a frame
  (frame kind: `steering.manifest`).

Without the manifest nobody can measure whether a record had any effect, and
retirement and promotion stay unbuildable.

ADR-091's `compileSteering` is the first version of the stable prefix. Phase 1
moves it behind `assembleSteering` without changing what a host receives for a
workspace that has only records.

### 2. One item type: `SteeringItem`

Fields: `id, lineage, kind, force, scope, body, token_cost,
enforcement_grant?, provenance, hash, valid_from`.

`kind` is one of `record`, `skill`, `memory`, `ontology`, `policy` (gate
notice), `instruction` (workspace additional instructions). `force` is one of
`must`, `should`, `may`, `info`.

`kind` here names the source family. A context record keeps its own six-way
classification (`rule`, `constraint`, `procedure`, `fact`, `memory`,
`preference`) on its row. The two are different columns with different
vocabularies and the adapter must not conflate them.

### 3. Source adapters

The record registry, `:AgentMemory`, gate notices from rules and mandates, skill
descriptions, and `promptConfig.additionalInstructions`. Each adapter returns
`SteeringItem`s and owns nothing else. Precedence is ADR-097 §4 and is applied
in the assembler, not in an adapter.

`additionalInstructions` becomes an `instruction` item. It is then ranked,
budgeted and listed in the manifest like anything else, which closes the gap
ADR-097's context describes.

### 4. Oxagen does not own the context window; the harness does

Oxagen's injection points are exactly five:

1. `SessionStart` additional context, capped at 16 KiB;
2. `UserPromptSubmit` additional context, which receives the prompt and so can
   retrieve by relevance;
3. MCP tool results;
4. files in the checkout, including skills;
5. the model request itself, only once the gateway's proxy exists (ADR-094).

So "competition for the window" means competition for Oxagen's slice of it.
The stable prefix rides point 1. The volatile selection rides point 2 from
Phase 1: `UserPromptSubmit` calls the assembler with the prompt as the query,
under a tight timeout, and fails open. From Phase 4 it also rides point 5, which
is where ADR-051's per-turn injection re-lands.

ADR-091 §3 sends `may` and `info` records to "context frames". This ADR names
the mechanism: the volatile selection, delivered at points 2 and 5.

### 5. The index sits behind a port

First on the Postgres registry. It moves to the graph (`:Record` nodes with
`ABOUT` edges, one direction registry to graph, verified by hash) in Phase 3,
when the knowledge graph is on by default, with Postgres kept as the fallback
behind the same port. Delivery never waits for the graph.

The graph earns its place through `ABOUT` edges: records relevant to the files
and entities this run touches. A workspace has tens of records, not millions,
so the Postgres path is enough to ship.

### 6. Skills are steering, and they are files

Governed like a record through a pull request, delivered by **sync**
(materializing files in the checkout), loaded by the harness's own progressive
disclosure. The skill's description line competes in the assembler like any
other item. Skills live under Steering.

Oxagen cannot put a skill body in the prompt. It can decide which skill files
exist in the checkout (point 4), what `search_skills` returns (point 3, ADR-090)
and whether the description line is rendered (points 1 and 2).

### 7. One home, one memory system

`packages/context-provider` becomes the assembler's home and reuses
`packWithinBudget`. `packages/engram` is deleted or folded in. The in-app
agent's `assistant-turn.ts` uses the same assembler, so there is one.

### 8. The two publish paths collapse

Every row carries `kind` and `force`. `publish_context_record` either writes
the classification columns or is retired in favour of the Context PR path. A row
with NULL `force` cannot be ordered and cannot be delivered.

## Consequences

- The manifest is a frame, so it is in the run's chain, replayable, and visible
  on the Run page. "Which records did this run see, and which were cut" becomes
  a read, not a guess.
- The Preview tab (ADR-097 §5) is the assembler run without delivery. It needs
  no second implementation.
- Where the volatile ranking runs is a build choice of Phase 1, inside one
  rule from ADR-094: no prompt body is sent to Oxagen's servers. If ranking needs
  the prompt, it runs in `tachod` against the item index the signed bundle
  carries. The server ranks only on what it already holds, such as the files
  and entities a run touches (spec §10.5).
- A slow or failing assembler never blocks a prompt at the hook tier. The cost
  of failing open is a turn with the prefix and no volatile selection, and the
  manifest records that.
- The `RECALL_LIMIT` constant goes away as a separate cap. Memory competes
  under the same budget as everything else.
- `@oxagen/context-provider` stops being a standalone stdio provider with no
  caller. Its Context Graph Protocol surface may stay as one more consumer of
  the assembler, and that is a Phase 1 build choice, not decided here.

## Supersedes and amends

- Amends ADR-008: skills are governed files under Steering, not a package with
  tables and a loader.
- Amends ADR-051: its volatile injection re-lands at `UserPromptSubmit` in
  Phase 1 and at the proxy in Phase 4.
- Amends ADR-090: `.oxagen/skills.toml` and resolution stand. Delivery by sync
  and the description line in the assembler are added.
- Builds on ADR-091 and does not change it.

## Alternatives considered

**Collapse everything into Neo4j and let the graph be the assembler.**
Rejected. The knowledge graph is off by default, and if delivery waits for the
graph nothing ships again. The graph is the index in Phase 3, behind a port,
with Postgres as the fallback.

**One assembler per surface** (one for the bundle, one for the in-app agent).
Rejected. Two assemblers is how a RULE-class memory and a published `must` came
to never share a prompt.

**Put skill bodies in the prompt.** Rejected. The harness loads skills by its
own rules and would load them again. Oxagen governs the file and competes with
the description line.

**Skip the manifest until later.** Rejected. Every later feature that asks
"did this item matter" reads it, and a manifest added later has no history.
