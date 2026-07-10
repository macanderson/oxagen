---
# Root Identity Dispatcher

- **Route:** `/`
- **Nav location:** none (system route — never appears in any sidebar, tab bar, or breadcrumb)
- **Priority:** P1
- **Disposition vs today:** Keep

## Purpose
The root route is a pure server-side redirect dispatcher, not a page. It resolves "who is this session and where do they belong" before any org/workspace scope exists, then sends the browser to the correct landing point: the login screen, the org-creation flow, or the user's first workspace. It is the single seam that turns an authenticated-but-unscoped session into a properly-scoped one, so every downstream route can assume `{orgSlug}`/`{workspaceSlug}` are already valid.

## Primary user & jobs-to-be-done
- **Primary user:** Any authenticated (or unauthenticated) visitor hitting the bare domain.
- **JTBD:**
  - Land on the app root and end up somewhere useful without seeing a blank or broken page.
  - Resume into my most recent/only org and workspace without re-selecting it every visit.
  - Be routed to org creation if I have no org yet, or to login if I have no session.

## Functionality
No rendered UI — this route never returns JSX to the client; it always calls `redirect()`. Decision table:

| Condition | Redirect target |
|---|---|
| No session (`session?.user` falsy) | `/login` |
| Session exists, user has zero `orgUsers` rows | `/new-organization` |
| Session exists, first org row has a workspace | `/{orgSlug}/{workspaceSlug}` |
| Session exists, first org row has no workspace | `/{orgSlug}` |

No filters, tabs, or interaction states beyond the redirect itself. There is exactly one query: a single left-join across `orgUsers` → `organizations` → `workspaces`, limited to 1 row, ordered by whatever the DB returns first (no explicit "last visited" ordering today — a future enhancement could sort by last-active workspace, but that is out of scope for this spec).

## Capabilities invoked
None. This route reads identity directly via `withSystemDb` before any tenant/capability scope is established — it runs pre-invoke(), by design (see Gotchas: "apps/app does not bootstrap IAM").

## Data sources
- **Postgres** (via `withSystemDb`, bypassing RLS deliberately — see inline comment `OXA-1515`): `organizations`, `workspaces`, `orgUsers` tables, read-only.
- No Neo4j, ClickHouse, or Blob access.

## States
- **Empty:** N/A — redirect happens before any render.
- **Loading:** N/A — server component, no client-visible loading state; browser sees only the redirect.
- **Error:** Unhandled DB error surfaces as the Next.js default error boundary; no bespoke error UI exists or is needed for a dispatcher this thin.

## Existing implementation
- **Today:** `apps/app/src/app/page.tsx`. Complete and correct as a pre-tenant identity resolver. Reuse as-is — no code changes recommended for the 2.0 IA; this spec exists to document the seam so downstream route renames (e.g. `studio/` → `workbench/`) don't silently break the redirect targets.

## Vision alignment
This is the entry seam for every accountability-chain action downstream — it establishes org+workspace identity before any metered capability can run. Keeping it a thin, side-effect-free dispatcher (P1) protects the integrity of that chain at its very first hop.
