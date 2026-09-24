## Self-Evaluation — SCIM #3734 / #3740 coverage audit — 2026-09-23

### What I set out to do
Rank the untested behaviour in the SCIM diff by blast radius, add unit tests that keep
@oxagen/handlers above its 85/77/74 gate, and prove the org fence on every statement
of pg-store.ts, the only code between a withSystemDb (RLS-bypassed) request and
another organization's people.

### What I actually did (measurable deltas)
- pg-store.ts: 0% -> 100% lines / 99% branches (new pg-store.test.ts, 48 tests).
- token-store.ts: 0% -> 100% (new token-store.test.ts, 10 tests).
- service.ts: 82.8% -> 100% lines, 68.4% -> 97.7% branches (+44 tests in service.test.ts).
- protocol.ts: new protocol.test.ts, 40 tests, 98.5% branches.
- apps/app sso.test.tsx: +4 SCIM component tests (rotate, last used, refused and thrown generate).
- Mutation-checked 6 fences (4 in pg-store, 2 in token-store); every one went red.

### Quality of my decisions
- Best: using drizzle's pg-proxy driver (precedent in packages/agent) instead of the
  where-only fake. It renders the real statement, so joins, ORDER BY, OFFSET and
  RETURNING are visible, and a `boundTo(column)` helper checks which value is bound to
  each `org_id = $n`, not merely that ORG appears somewhere.
- Weakest: I ran mutation probes by editing pg-store.ts in place while another session
  was about to edit the same file. Each probe was restored within one command, but the
  coordinator saw one. In a shared tree, run mutants in a scratch copy
  (vi.mock the module path to the mutant) rather than in the source file.

### What I could have done better
1. Asked for or checked the file-ownership plan before the first mutation probe on a
   production file.
2. Read WriteDialog's failure mapping before writing the component failure test. I found
   the sso-failure/action-failure split late, after I had already drafted an assertion on
   the designed sentence.
3. Measured the package-wide handlers coverage figure from CI output rather than
   estimating it from line counts. gh was not installed, and I did not try the GitHub MCP.

### What surprised me about this codebase/product
- The SCIM store writes the GLOBAL auth.users row (email, display name) for any member
  of the calling org, and the only guard is a domain check on the NEW email.
- The organization SSO section has two failure vocabularies, and WriteDialog is wired to the one without SCIM words.

### Risks I am leaving behind
- member-lifecycle.ts branch gaps (host key caught by the sweep, principal re-read
  failure, and the SCIM marker never asserted) are left untested, because the main session owns that file right now.
- Only the rls-integration job runs pg-store against real Postgres. The unit tests prove the SQL shape, not the RLS policy.

### Confidence in the result: high for the fences (mutation evidence), medium for package-level coverage (not measured package-wide).
