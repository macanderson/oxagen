---
name: scoped-session-orgid-audit-oxa-2062-findings
type: bug
domain: knowledge-graph
severity: P2
linear: OXA-2062
date: 2026-07-04
---

**Symptom:** OXA-2052 fixed one confirmed instance of the "$orgId referenced in
Cypher but omitted from the resolver's own local params object" defect class
in `packages/ingestion/src/dedup/resolve.ts`. This ticket audited the rest of
the codebase for the same class — resolvers that only work today because
`scopedSession()` (`packages/ontology/src/tenant.ts`) silently splices the
real `orgId`/`workspaceId` into the params object AFTER the caller's own,
papering over the missing bind. That auto-injection is a good safety net, but
it means the bug is invisible to any test that exercises the REAL
`scopedSession()`, and would silently produce an unscoped/cross-tenant query
the moment a future refactor bypasses the wrapper (raw driver call, a mocked
session, a new caller).

**Root cause:** a widespread pattern across `packages/handlers`,
`packages/ontology/src/mutations`, and `packages/ingestion` where a
resolver's local params object omitted `orgId`/`workspaceId` even though its
Cypher text referenced `$orgId`/`$workspaceId` in a `MATCH`/`MERGE` key or
`WHERE` clause. Two flavours found:
1. Some files had an explicit code comment saying "injected automatically by
   scopedSession()" — a deliberate-looking but still fragile convention.
2. `packages/ingestion/src/mutations/upsert-entity.ts` (the mutation layer
   `resolve.ts` itself calls into — NOT excluded by the OXA-2052 scope, which
   only excluded `resolve.ts`) had FIVE functions
   (`upsertEntityNode`/`createAliasEdge`/`upsertEmbedding`/
   `upsertSourceConnectionMeta`/`upsertInferredEdges`) whose second/fourth
   constructor arg was literally named `_orgId` (leading underscore = marked
   unused) — a refactor left the param dead and never wired it into the
   params object at all. This is the exact same defect class as OXA-2052,
   found in the underlying layer.
3. `packages/ontology/src/mutations/record-execution.ts` had the MERGE key
   `{id: $executionId, orgId: $orgId}` (its idempotency key) with `orgId`
   never destructured from `input` and never passed to ANY of its five
   `session.run()` calls — a hot-path lineage writer for every agent
   execution.

**Fix:** bound `orgId`/`workspaceId` explicitly in the local params object at
every genuine finding (16 files), defense-in-depth on top of the existing
`scopedSession()` auto-injection safety net:
- `packages/handlers/src/graph.node.upsert.ts` (both session.run calls),
  `graph.node.delete.ts`, `graph.node.label.add.ts`, `graph.node.label.remove.ts`,
  `graph.node.labels.get.ts`, `graph.node.search.ts`, `graph.ingest-vocabulary.ts`
  (previously had NO params object at all), `graph.sync.push.ts` (4 calls),
  `graph.edge.upsert.ts` (2 calls), `graph.edge.delete.ts`,
  `semantic.edge.approve.ts` (2 calls), `semantic.edge.suggest.ts` (2 calls),
  `semantic.edge.list.ts` (shared params object, 2 calls).
- `packages/ontology/src/mutations/record-execution.ts` (all 5 session.run calls).
- `packages/ingestion/src/mutations/upsert-entity.ts` (renamed `_orgId` → `orgId`
  and threaded it through all 5 functions) and
  `packages/ingestion/src/infer/index.ts` (2 session.run calls).

**Guard:** every fix ships a regression test that mocks `scopedSession()` /
the session wrapper DIRECTLY (a plain `vi.fn()`, no auto-injection logic —
the same pattern OXA-2052's `resolve.test.ts` established), then asserts the
local params object passed to `session.run()` contains the explicit
`orgId`/`workspaceId` value. Spot-verified empirically: reverted the
`upsertEntityNode` MERGE-params fix and re-ran
`packages/ingestion/src/mutations/__tests__/upsert-entity.test.ts` — the new
regression test failed as expected (`expected undefined to be 'org-42'`);
restored the fix and it passed again. 156 tests green in `@oxagen/handlers`,
46 in `@oxagen/ontology`, 38 in `@oxagen/ingestion` after the full fix set.

**Watch-outs:** `packages/agent/src/memory/neo4j.ts` and
`packages/agent/src/adapters/code-graph.ts` follow an even stronger version of
this pattern — NO function in either module accepts `orgId`/`workspaceId` as
an argument at all (by explicit module-level design comment in
`neo4j.ts`: "never thread them through function args"), relying 100% on
`scopedSession()`. This is architecturally deliberate (not a leftover `_orgId`
dead param) and fixing it would mean adding `orgId`/`workspaceId` params to
~15 exported functions and updating every caller across the codebase — out of
scope for this audit. See the companion observation memory
`scoped-session-orgid-two-tier-risk-agent-memory-code-graph.md`.
