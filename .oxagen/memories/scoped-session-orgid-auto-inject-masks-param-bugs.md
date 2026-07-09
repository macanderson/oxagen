---
name: scoped-session-orgid-auto-inject-masks-param-bugs
type: observation
domain: knowledge-graph
date: 2026-07-04
---

**Observation:** `scopedSession()` in `packages/ontology/src/tenant.ts`
(added 2026-06-05, commit `b93d05b6`, OXA-1515) wraps every Cypher `run()`
call as `s.run(cypher, { ...params, orgId, workspaceId })` — it destructures
`orgId`/`workspaceId` from the AsyncLocalStorage tenant scope
(`requireScope()`) and splices them in AFTER the caller's own `params`, so
they always win regardless of whether the caller's params object included
its own (possibly stale, possibly missing) `orgId`/`workspaceId`.

**Why this matters:** this is genuinely good defense-in-depth — a caller
that forgets to thread `orgId` into a Cypher params object (the exact class
of bug OXA-2052 described) is silently self-healed as long as the query runs
inside the correct `runInTenantScope()`. But it also means any test that
exercises the REAL `scopedSession()` (rather than mocking it) cannot detect
that specific "forgot the param" bug class — the wrapper papers over it. Only
a test that inspects the raw `params` object passed to a MOCKED
`session.run()` (before the wrapper's override) actually catches a
regression here. Verified empirically: reverting the OXA-2052 Pass-A fix and
re-running both `resolve.test.ts` (mocked) and the new
`resolve.integration.test.ts` (real Neo4j) — the mocked test failed as
expected, the integration test still passed.

**Watch-outs:** the flip side is a mismatch bug this wrapper CAN introduce —
if a caller ever invokes `resolveEntity(mutation, orgId)` (or any
`scopedSession()`-based helper) with an explicit `orgId` argument that
DIFFERS from the ambient `runInTenantScope()` scope, the query silently runs
under the AMBIENT scope's orgId, not the argument — a real tenant-isolation
foot-gun for any future refactor that decouples the two. Keep them threaded
together (call `runInTenantScope({ orgId, workspaceId }, ...)` immediately
around any `resolveEntity`/`upsertEntityNode`/etc. call with the SAME
`orgId`) rather than assuming the explicit argument alone scopes the query.
