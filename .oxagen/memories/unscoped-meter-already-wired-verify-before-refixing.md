---
name: unscoped-meter-already-wired-verify-before-refixing
type: observation
domain: database
date: 2026-07-04
---

**Observation:** Ticket OXA-2056 described `packages/database/src/unscoped-meter.ts`'s `recordIfUnscoped()` as "dead code that is never called from anywhere." By the time this ticket was picked up, it was already fully wired: `packages/database/src/tenant.ts`'s `withSystemDb()` calls `recordIfUnscoped("withSystemDb")` on every invocation, and `packages/database/src/tenant.test.ts` already has a passing regression test for exactly this wiring (its own comment literally says "The unscoped-access meter was dead code until withSystemDb wired it"). This was almost certainly closed by an earlier commit (git log points to PR #561, "fix(security): RLS fail-closed in prod...").

**Why this matters:** Linear tickets in this repo can lag actual `main` state — a prior parallel session may have already fixed part of a multi-part ticket. Before re-implementing a described defect, run the narrowest test for the file in question first (`CI=true pnpm --filter @oxagen/database test:unit -- tenant.test.ts unscoped-meter.test.ts`) to check whether the described behavior is already correct. Re-verified other plausible unscoped seams too: `withTenantDb()` can't run unscoped at all (its `requireScope()` throws first), Neo4j's `scopedSession()` (`packages/ontology/src/tenant.ts`) has its own hard-throw `TenantScopeError` guard (no soft counter needed), and the one legitimate raw `db()` import outside `packages/database` (Better Auth's `drizzleAdapter(db(), …)` in `packages/auth/src/auth.ts`) targets tables with no RLS policy at all (`Better Auth` tables are explicitly excluded from `packages/database/src/tenant-policy.manifest.ts` as a shared/system catalog), so it isn't a tenancy-scoping gap either.

**What I still did for OXA-2056:** Added `packages/database/src/unscoped-meter.integration.test.ts` — a NEW test that deliberately does NOT mock `./unscoped-meter` (unlike `tenant.test.ts`, which does), so it exercises the REAL `__unscopedCountForTests()` counter end-to-end through `withSystemDb()`. This closes the gap between "the mock was called with the right args" and "the real counter actually advances," which is the strongest form of the regression guard the ticket asked for.
