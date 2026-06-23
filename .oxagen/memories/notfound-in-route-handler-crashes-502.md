---
name: notfound-in-route-handler-crashes-502
type: bug
domain: api
severity: P1
linear: OXA-1814
date: 2026-06-23
---

**Symptom:** `GET /api/v1/mcp/oauth/authorize` on app.oxagen.sh returned HTTP 502
(FUNCTION_INVOCATION_FAILED) with no JSON body — the serverless function crashed
rather than returning a handled error. Handled errors in this codebase return
JSON, so a 502 with no body = an uncaught throw.

**Root cause:** The route handler called `resolveOrg(orgSlug)` and
`assertMcpManager(orgId, userId)` from `@/lib/resolve-org` *outside any
try/catch*. Those gates signal denial by calling `notFound()`, which **throws**
`HTTPAccessFallbackError` (digest `NEXT_HTTP_ERROR_FALLBACK;404`). `notFound()`
is only caught by a Next.js **not-found render boundary** — pages/segments have
one, **Route Handlers (`route.ts`) do not**. So the thrown sentinel escaped the
handler uncaught → Vercel reported FUNCTION_INVOCATION_FAILED → HTTP 502.
Triggered by a stale/unknown `orgSlug`, a non-member, or a non-owner/admin caller.

**Fix:** Wrapped the exported `GET` so the real body runs in `handleAuthorize()`
inside a try/catch:
- A `notFound()` fallback → mapped to a clean 4xx JSON via the new
  `authDenialStatus()` helper (404 = "not found or not permitted").
- A Next redirect sentinel (`permanentRedirect`) → re-thrown via the new
  `isNextRedirectError()` so Next can build the redirect response.
- Any other throw (DB outage, SDK bug) → logged structured error + clean 500 JSON.
Same wrapper added to the co-located `callback/route.ts` (its DB awaits could
also crash → 502). Helpers live in `apps/app/src/lib/auth-denial.ts`.

**Guard:** `apps/app/src/app/api/v1/mcp/oauth/authorize/route.test.ts` mocks the
gates to throw the notFound sentinel and asserts `GET` *resolves* to a 404
Response (never rejects); plus a DB-throw → 500 case. **Verified the 3
crash-condition tests FAIL on HEAD (pre-fix) and PASS on the fix.** Helper unit
tests in `auth-denial.test.ts`.

**Watch-outs:** ANY `route.ts` that calls a `resolve-org` gate (`resolveOrg`,
`assertOrgMember`, `assertMcpManager`, `assertBillingManager`,
`assertWorkspaceMember`, `assertSecurityManager`, `resolveWorkspace`) is exposed
to this exact 502 — those gates throw `notFound()`, which has no boundary in a
route handler. Always wrap route handlers that call them. Server *actions* and
*pages* are fine (they have boundaries / are caught by callers). Route handlers
are excluded from this package's vitest coverage gate, so a unit test here does
not raise coverage but is still the regression guard.
