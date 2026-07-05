---
name: scopedsession-orgid-explicit-bind-breaks-mock-assertions
type: observation
domain: ingestion
severity: P2
linear: OXA-2073
date: 2026-07-04
---

**Symptom:** `pipeline-integration.test.ts` assertion
`expect(params["orgId"]).toBeUndefined()` failed with "expected 'org-integration'
to be undefined".

**Root cause:** `scopedSession().run()` (`packages/ontology/src/tenant.ts`) always
injects `{ ...params, orgId, workspaceId }`, so historically resolver code omitted
`orgId` from its own params and relied on the shim. PR #608 (OXA-2062) then bound
`orgId` EXPLICITLY in ~16 resolvers (incl. `upsertEntityNode`). Any **mock-based**
test that replaces `scopedSession` with a bare fn (no injection) and asserts on the
captured params now sees the explicitly-bound value — the old "orgId is only in the
MERGE pattern, not params" assumption is stale.

**Fix:** Updated the assertion to `toBe("org-integration")`.

**Watch-out:** When a resolver adds an explicit `$orgId`/`$workspaceId` param binding,
grep for mock tests that stub `@oxagen/ontology/tenant`'s `scopedSession` and assert
those params are `undefined` — they will break and the correct new expectation is the
bound tenant id, not `undefined`. The explicit bind is intentional (self-documenting,
robust to being run without the scoping shim); do not revert it to fix the test.
