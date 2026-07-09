---
name: dedup-resolve-orgid-already-fixed-needs-integration-test
type: bug
domain: ingestion
severity: P2
linear: OXA-2052
date: 2026-07-04
---

**Symptom:** OXA-2052 alleged `packages/ingestion/src/dedup/resolve.ts` Pass-A
Cypher referenced `$orgId` but the params object only supplied `naturalKey`,
so Neo4j would treat `orgId` as `null` and never match an existing principal
— every re-delivery of the same `naturalKey` would create a duplicate
principal node (unbounded duplicate-principal accumulation).

**Root cause (historical):** true when `resolveEntity()` was first written
(commit `2729c185`, 2026-06-09) — the Pass-A params object was
`{ naturalKey: mutation.naturalKey }`, missing `orgId`. Pass B (the vector
index WHERE clause params) had the identical omission.

**Already fixed:** commit `e12a9713` ("Fix/silent failures critical high
(#75)", 2026-06-20) added `orgId` to both Pass A and Pass B params, well
before this ticket was worked. Verified via `git log -p --follow -- resolve.ts`
and `git merge-base --is-ancestor e12a9713 HEAD`. The current code has orgId
as a required, non-optional parameter threaded through
`resolveEntity(mutation, orgId, opts)` into both passes.

**What was genuinely missing:** the ticket's explicit ask for a NON-MOCKED
integration test against a real Neo4j instance. The pre-existing
`src/dedup/__tests__/resolve.test.ts` only asserted the mocked `session.run`
call args contained `orgId` — it never proved the real Cypher/MERGE semantics
against a live graph. Added
`packages/ingestion/src/dedup/__tests__/resolve.integration.test.ts`,
following the local-Postgres integration pattern in
`packages/inngest-functions/src/lease.integration.test.ts` (skip cleanly when
the dependency is unreachable).

**Guard:** the new integration test asserts (1) redelivering the same
mutation returns `action: "updated_principal"` with the SAME
`principalNodeId`, (2) exactly one `EntityNode` exists in the graph for that
naturalKey+orgId afterward, and (3) the same naturalKey under a different
orgId creates a separate principal (tenant isolation).

**Watch-outs:** see the companion observation
`scoped-session-orgid-auto-inject-masks-param-bugs.md` — the real
`scopedSession()` wrapper auto-injects `orgId`/`workspaceId` from the active
tenant scope into EVERY params object regardless of what the caller supplies,
so this new integration test does NOT actually catch a reintroduction of the
"forgot to pass orgId in resolve.ts's own params" bug (I verified this by
temporarily reverting the Pass-A fix and re-running both test files: the
mocked test failed as expected, the new integration test still passed). The
mocked `resolve.test.ts` regression assertions remain the real guard for that
specific class of bug.
