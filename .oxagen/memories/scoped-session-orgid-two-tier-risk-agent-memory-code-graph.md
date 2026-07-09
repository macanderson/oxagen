---
name: scoped-session-orgid-two-tier-risk-agent-memory-code-graph
type: observation
domain: knowledge-graph
date: 2026-07-04
---

**Observation:** during the OXA-2062 audit of resolvers relying on
`scopedSession()`'s `orgId`/`workspaceId` auto-injection
(`packages/ontology/src/tenant.ts`), two modules stood out as a STRONGER, more
consistent version of the risk pattern than the mechanical "forgot to bind"
bugs fixed elsewhere in that ticket:

- `packages/agent/src/memory/neo4j.ts` (the two-axis agent-memory repository —
  `recallMemories`, `listMemories`, `writeMemory`, `updateMemory`,
  `getMemoryById`, `deleteMemory`, `listDecayableMemories`,
  `applyDecayToMemory`, `reinforceMemory`, `promoteMemory`,
  `listPromotionCandidates`, `recordExecution`, `recordCitation`,
  `listExecutionCitations`, `attachEvidence` — ~15 exported functions).
- `packages/agent/src/adapters/code-graph.ts` (`CodeGraphProvider.query`) and
  `packages/agent/src/adapters/graph-sync.ts` (`ensureGraph`).

Unlike the fixed OXA-2062 instances, these modules don't even ACCEPT
`orgId`/`workspaceId` as function arguments — `neo4j.ts` states explicitly in
its module doc comment: "orgId/workspaceId are injected automatically by
scopedSession() from the active tenant scope — never thread them through
function args." This is a deliberate architectural choice, not a leftover
`_orgId` dead param, so it wasn't treated as a mechanical fix in this pass.

**Why this matters:** it's the same risk class (any caller of these functions
outside a live `runInTenantScope()` — a raw driver call, a mocked session in
a unit test, a future refactor) would silently produce an unscoped query with
zero compile-time or param-level signal, because there is no local `orgId` to
even bind. Fixing it properly means adding `orgId`/`workspaceId` params to
~15 exported functions AND updating every call site across `apps/*` and
`packages/*` — a much larger, cross-cutting change than an audit ticket
should make unilaterally. `packages/agent/src/adapters/graph-sync.ts`'s
`recordLineage()` already works around the asymmetry by passing
`orgId: "", workspaceId: ""` placeholder strings into
`recordExecutionInGraph()` with a comment acknowledging `scopedSession()`
will override them — confirming the pattern is known and tolerated, not
accidental.

**Watch-outs:** if a future body of work threads `orgId`/`workspaceId`
through `packages/agent/src/memory/neo4j.ts` or the code-graph/graph-sync
adapters for defense-in-depth (mirroring the OXA-2062 fixes elsewhere), budget
for updating every caller, not just the module itself — this is NOT a
same-file mechanical change like the other OXA-2062 fixes were.
