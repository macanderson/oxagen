# ADR-097: Steering and gating are two planes, authored on one surface and compiled twice

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, app
- **Decided by:** the maintainer, 2026-09-18, approving the architecture review
  of the same date ("steering, the graph, and the gateway") in full
- **Related:** ADR-091 (Phase 0: one record steers one agent), ADR-093 (the
  assembler), ADR-094 (the gateway), ADR-095 (the tier ladder), ADR-096 (the
  contained tier), ADR-051 and ADR-061 (context records and their governance),
  ADR-059 and ADR-070 (mandates and auto-approval rules), ADR-090 (skill
  resolution), ADR-003 and ADR-087 (Neo4j), the Mission Control spec sections
  "Stores and writers" (§4.2), "The three seams" (§7) and "Steering" (§10)
- **Numbering:** this is the first of five ADRs from one decision and reads
  before ADR-093 to ADR-096. It is 097 because ADR-092 was taken by #3292 (an
  unrelated decision) while the set was being written
- **Delivered by:** Phase 1 (both compilations, precedence), Phase 2 (the one
  authoring surface), Phase 4 (the second compilation reaches the bundle)

## Context

The review read `main` at `85377729a`. Every fact below was checked again at
`02278c913` (after the Run page landed in #3282). Where the review is out of
date, this section says so.

Eight families of thing can influence a run, and they do not meet:

| Source | Where it lives | Reaches a wrapped agent today |
|---|---|---|
| Context records | `agent.context_records` and its versions, promotions ledger and proposals (`packages/database/src/schema/agent.ts`), mirrored as `.oxagen/rules/*.toml` in git | No at `main`. ADR-091 (PR #3289, open) compiles `must` and `should` records into the bundle. Until it merges, `rg contextRecords` finds handlers, schema, routes and the app's read model, and no run-time reader |
| Policy bundle `context.system` | `packages/tacho/src/wire.ts` (schema, capped at 16,384 characters), read by `packages/tacho/src/collector/hook-handler.ts` at `SessionStart` | No. `unsignedBundle` hardcodes `context: { system: null }` (`packages/handlers/src/lib/tacho-host.ts:276`) |
| Bundle permissions, tools, budget | the same function, lines 269 to 275 | No. `allow`, `deny` and `ask` are empty arrays, `tools` is empty, `budget.mode` is `"observed"`. `session_limit_usd` exists in the wire schema and nothing reads it |
| Skills | ADR-008 describes `packages/skills` and `agent.skills` tables. Neither exists. `tacho.sessions.skills_available` is an inventory of what the harness reported. ADR-090 (accepted the same day as this ADR) decides resolution and is not built | No |
| Knowledge graph and ontology | Neo4j through `packages/ontology` and `packages/ingestion` | Only when the model calls a `graph.*` tool, and only when `NEO4J_URI` is set |
| Memory | Neo4j `:AgentMemory`, recalled by `packages/agent/src/runtime/assistant-recall.ts` | In-app agent only, capped at 6 (`RECALL_LIMIT`) |
| Decision rules, mandates, auto-approval | `workspaces.settings.decisionRules`, `tools.mandates` | They refuse calls at `kernel.invoke()`. They produce no prompt text, and a wrapped agent's built-in tools never pass through them |
| `promptConfig.additionalInstructions` | Postgres JSONB on the workspace | In-app agent only, appended unconditionally by `resolvePrompt` (`packages/ai/src/prompts/registry.ts`) |
| Operator steer commands | `tacho.control_commands`, drained in `hook-handler.ts` | Yes. This is the only live server-to-running-agent text channel for wrapped agents |

One review claim does not hold at `main`. The review said a prompt override
"can replace the whole governance prompt with no check". `OVERRIDABLE_PROMPT_KEYS`
is `["conversation.title"]`, and `chat.system` is append-only, so replacement of
the governance prompt is refused. What remains true is narrower: the appended
`additionalInstructions` text is unranked, unbudgeted, and never compared with a
rule or a published `must` record.

Two things follow. A rule that refuses and a record that advises never appear in
the same place, so no precedence between them was ever written down. And a
workspace that wants "never push to main" has to choose between a record the
model may ignore and a rule the model never hears about until it is refused.

## Decision

### 1. Storage stays plural, one writer per fact

The system of record is: **git** for what is published; **Postgres** for what
must be transactional or money-grade; **the graph** for lineage, evidence and
entity links. Only the assembler (ADR-093) and its index are single. Nothing is
collapsed into Neo4j.

"Single source" was three different things in the discussion that led here: the
system of record (where a fact is authored), the index (where facts are queried
at run time) and the assembler (where they compete for the window). Only the
last two must be single.

### 2. Two planes that never merge

**Steering** is what the model reads: advisory, ranked, budgeted, may be
dropped.

**Gating** is what the kernel refuses: deterministic, never budgeted, never
ranked, works when Neo4j is down.

A deny rule that lived only in a graph and competed for context could be
dropped by a relevance score. A gate is therefore never an input to ranking and
never depends on a store that can be off.

### 3. One authoring surface, two compilations

Every item compiles to text. An item with an enforcement grant also compiles to
bundle permissions and kernel rules. Every gate also emits a one-line **gate
notice** into steering so the agent does not walk into a denial.

The first compilation is ADR-093's `assembleSteering`. The second fills the
`permissions` block `unsignedBundle` leaves empty today and the rule set the
kernel already evaluates (ADR-070). The second compilation is written in Phase
1 and reaches a wrapped agent in Phase 4, when bundle permissions are filled.

### 4. Precedence, fixed in one place

A gate beats everything. A published `must` beats recalled memory. Repository
scope may narrow workspace scope and never widen it.

The rule lives in the assembler's package and nowhere else. A recalled memory of
class RULE is rendered today as "never violate a RULE" while a published `must`
record is never in the same prompt. After Phase 1 they are, and the published
record wins.

### 5. One screen: Steering is the hub

Tabs, in this order: **Records, Skills, Memory, Ontology, Policy, Proposals,
Preview.** Preview: pick an agent and a prompt, see exactly what would be
injected, what was cut, and why. Skills and Ontology have no top-level nav entry
of their own any more.

At `main` the workspace nav carries `tools`, `skills` and `steering` as separate
entries (`apps/app/src/features/shell/nav.ts`), and Ontology has no entry. Phase
2 removes `skills` from `WORKSPACE_NAV` and redirects its route to the Skills
tab.

## Consequences

- "Policy" on the Steering hub is an authoring view of gates and their notices.
  The gate itself still runs in the kernel and, from Phase 4, in the bundle. The
  tab does not make a gate advisory.
- ADR-091 §5 stays true until Phase 1: a constraint record is text and nothing
  else, and a denial belongs to the decision-rules engine. Phase 1 adds the
  enforcement grant that lets one authored item produce both.
- ADR-090's Skills page becomes the Skills tab of the hub. See the amendment on
  ADR-090.
- A control claim always carries its scope: "for actions routed through
  Oxagen". At the hook tier a gate is "delivered", "recorded",
  "client-attested" and "fail-open", never "enforced" (ADR-095).
- New governance ceremony stays frozen under ADR-091 §6 until a merged record
  is seen in a real run.

## Supersedes and amends

- Amends ADR-090: Skills is a tab under Steering, not a top-level page.
- Amends ADR-008: see its status note.
- Does not change ADR-003 or ADR-087. Neo4j stays, and it stays out of the gate
  path.

## Alternatives considered

**Collapse everything into Neo4j.** Rejected. The graph is off unless
`NEO4J_URI` is set, a gate must work when it is down, money-grade rows need
Postgres transactions, and published records need git review. A single store
would also make the graph a delivery dependency, and delivery has already waited
once (ADR-051's path was deleted by ADR-043 and nothing replaced it for ten
days).

**Merge steering and gating into one ranked list.** Rejected under §2. Anything
ranked can be cut, and a gate that can be cut is not a gate.

**Keep separate screens per source.** Rejected. The competition for the window
is invisible when each source has its own page, and Preview has nowhere to live.
