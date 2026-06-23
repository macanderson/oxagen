---
name: route-handlers-need-throw-safety-wrapper
type: observation
domain: api
severity: P2
linear: OXA-1812
date: 2026-06-23
---

**Observation:** Next.js App Router **Route Handlers** (`apps/app/src/app/**/route.ts`)
are a fragile class in this repo: any uncaught throw becomes a Vercel
FUNCTION_INVOCATION_FAILED (HTTP 502) with no JSON body, because a route handler
has **no error/not-found render boundary** the way pages and layouts do. Three
common throw sources are easy to miss because they pass typecheck/lint/unit
tests and only manifest in prod:

1. **`notFound()` from `@/lib/resolve-org` gates** — control-flow throw, no
   boundary in a route handler (see `notfound-in-route-handler-crashes-502`).
2. **Bare DB awaits** (`withSystemDb`, `loadOAuthState`, etc.) outside try/catch —
   a connection refused / timeout rejects and crashes the function.
3. **Third-party SDK calls** (e.g. MCP `mcpAuth`) that can reject mid-flow.

**Pattern to apply:** keep the handler body in an inner `handleX(req)` and make
the exported `GET`/`POST` a thin wrapper that try/catches everything, re-throws
genuine Next redirect sentinels (`isNextRedirectError`), maps auth denials to
4xx (`authDenialStatus`), and turns anything else into a logged 500 JSON. The
seam helpers live in `apps/app/src/lib/auth-denial.ts`.

**Why it stays invisible:** route handlers are excluded from the `apps/app`
vitest coverage gate (`src/app/**/route.ts` in `coverage.exclude`) — they are
meant to be e2e-tested against the real stack. So an untested route handler
won't drag coverage down or trip CI, and the 502 only shows up in prod
telemetry. When you touch a route handler, add a unit test for its failure modes
even though it won't move the coverage number.
