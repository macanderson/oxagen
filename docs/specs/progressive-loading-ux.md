# Progressive Loading UX

Archived spec & plan — status: shipped (audited 2026-07-03).

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Progressive Loading UX feature has been fully shipped and merged to main (PR #76, 2026-06-20). All five core deliverable categories are implemented: spinner path fix with CSS fallback, reusable skeleton primitives, app-wide loading.tsx files at major segment roots, layout de-blocking via navDataPromise streaming, and heavy-segment refactoring with concurrent Suspense boundaries. 43 files changed with 1869 insertions.

**Implementation evidence**

- apps/app/src/components/pwa/route-transition-loader.tsx - spinner path corrected to /spinner/ with onError CSS fallback
- apps/app/src/components/loading/index.ts - barrel export of 5 skeleton primitives (PageHeader, Table, CardGrid, StatCards, Detail) plus LoadingRegion
- apps/app/src/app/[orgSlug]/loading.tsx - org-level loading skeleton
- apps/app/src/app/[orgSlug]/[workspaceSlug]/loading.tsx - workspace-level loading skeleton
- apps/app/src/app/[orgSlug]/billing/loading.tsx - billing segment loading skeleton
- apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/loading.tsx - knowledge segment loading skeleton
- apps/app/src/app/[orgSlug]/layout.tsx - navDataPromise deferred off critical path with Suspense slots, line 112-115 references progressive-loading-ux
- apps/app/src/app/[orgSlug]/[workspaceSlug]/knowledge/repos/page.tsx - Suspense-wrapped SourcesSection with TableSkeleton fallback matching spec Section E pattern
- apps/app/src/components/pwa/spinner-assets.test.tsx - test coverage for spinner path correction and onError fallback
- apps/app/src/components/loading/loading-skeletons.test.tsx - unit tests for skeleton structure, aria attributes, CLS safety
- git commit eeb38731 Feat/progressive loading ux (#76) with 43 files changed, 1869 insertions covering all deliverables

**Source documents** (archived verbatim below)

- `docs/specs/progressive-loading-ux/SPEC.md`

## Spec — `SPEC.md`

## Progressive loading UX + transition-spinner fix — design spec

**Date:** 2026-06-20
**Branch / worktree:** `feat/progressive-loading-ux` (`../oxagen-loading-ux`)
**App:** `apps/app` (Next.js 16.2.7, App Router, RSC + streaming)

### Problem

1. **No `loading.tsx` anywhere app-wide** (verified: zero `loading.{ts,tsx,jsx}` under `apps/app/src/app`). The
   heaviest segments (billing, activity, knowledge, automation) block the entire route render on their slowest
   server fetch, with no progressive reveal. Navigation shows a blank/stale screen until everything resolves.
2. **Broken-image icon on mobile during page transitions.** The route-transition loader renders an `<img>` whose
   `src` points at `/pwa/oxagen-spinner-assemble-{dark,light}.gif`, but those GIFs actually live at
   `/spinner/…`. `public/pwa/` holds only PWA icons + `manifest.json`. The transition loader is **mobile-gated**
   (CSS media query) and fires for ~600ms on every navigation, so mobile users get the browser broken-image
   placeholder on every transition. Desktop hides the element, so it is invisible there.

### Verified current state

- **Zero `loading.tsx`.** Only client-side `<Suspense>` boundaries exist (7, all in `components/chat/*`). No
  RSC page-level streaming.
- **`@oxagen/ui` exports `Skeleton`** (`animate-pulse rounded-md bg-primary/10`) and the local re-export
  `apps/app/src/components/ui/skeleton.tsx` already exists (`export * from "@oxagen/ui/components/skeleton"`).
  No skeleton **composites** exist yet.
- **Route-level error convention:** only `apps/app/src/app/global-error.tsx`. No per-segment `error.tsx`
  (out of scope for this change).
- **Waterfalls in the heavy segments:**
  - the former knowledge inference page — 3 **sequential** capability reads. This page and
    its legacy semantic review family were later retired for launch.
  - `activity/runs/page.tsx` — sequential resolves, then `invoke("agent.subagent.fanout.list")` then a
    `withTenantDb` executions query, serial inside `runInTenantScope`.
  - `knowledge/sources/page.tsx` — single blocking `invoke("connection.list")` gates the whole page.
  - `billing/subscription/page.tsx` — two sequential `Promise.all` batches (batch 2 waits for all of batch 1).
  - `automation/playbooks/page.tsx` — pure mock data, no `async`/`await` (heaviness latent, not active).
- **Layout-level blocking:** `[orgSlug]/layout.tsx` runs `Promise.all([org list join, workspace list,
  isLowBalance])` after auth/resolve. Because a layout renders `\{children}`, this **blocks every org-scoped
  child** — so a child segment's `loading.tsx` cannot paint until the layout's `Promise.all` resolves.
  `[workspaceSlug]/layout.tsx` only does lightweight sequential resolves.

### Decisions (approved 2026-06-20)

- **Reveal depth (heavy segments): Stream + parallelize.** Each slow fetch becomes its own `<Suspense>`-streamed
  section so the shell + fast content paints immediately and slow sections fill in independently; sequential
  `invoke()` waterfalls collapse to concurrent fetches.
- **Coverage: App-wide.** A `loading.tsx` at every major segment root; the deeper streaming treatment is applied
  to the heavy segments.
- **Spinner: Fix path + harden.** Correct `/pwa/` → `/spinner/` and add an `onError` fallback to a pure-CSS
  spinner so a missing/renamed asset can never surface a broken-image icon again. The branded GIF stays primary.
- **Include layout de-blocking (#4).** Approved despite shared-layout blast radius; covered by e2e.

### Architecture

#### A. Spinner fix + hardening

Files: `apps/app/src/components/pwa/route-transition-loader.tsx`,
`apps/app/src/components/pwa/pwa-splash.tsx` (+ their `.module.css`).

- Correct the four `src` attributes: `/pwa/oxagen-spinner-assemble-{dark,light}.gif` →
  `/spinner/oxagen-spinner-assemble-{dark,light}.gif`.
- Both components are `"use client"`. Add a pure-CSS spinner element as a sibling, hidden by default
  (`display:none`), and an `onError` handler on each `<img>` that hides the broken image and reveals the CSS
  spinner. The CSS spinner is a bordered `@keyframes spin` element gated on `prefers-reduced-motion: reduce`
  (matching the existing reduced-motion handling), so it degrades gracefully and can never 404.
- Confirm the `.module.css` files contain no stale asset reference (investigation indicates they only handle
  dark/light visibility + the mobile / reduced-motion gates — verify during implementation).

#### B. Reusable skeleton primitives (no copy-paste)

New domain folder `apps/app/src/components/loading/`, composing `@/components/ui/skeleton`:

- `page-header-skeleton.tsx` — `<PageHeaderSkeleton>` (title bar + optional action button placeholder).
- `table-skeleton.tsx` — `<TableSkeleton rows cols>` (header row + N body rows).
- `card-grid-skeleton.tsx` — `<CardGridSkeleton count>` (responsive card grid placeholders).
- `stat-cards-skeleton.tsx` — `<StatCardsSkeleton count>` (metric/stat tiles).
- `detail-skeleton.tsx` — `<DetailSkeleton>` (header + body block for detail pages).

Constraints:
- Each composite **mirrors the real layout's dimensions** to avoid Cumulative Layout Shift when content swaps in
  (`frontend-patterns/performance`, CWV). No new arbitrary spacing — reuse the page's existing spacing tokens.
- Each carries `aria-busy="true"` and a descriptive `aria-label`, matching the existing chat-shell convention.
- Index barrel `apps/app/src/components/loading/index.ts` for clean imports.

#### C. App-wide `loading.tsx`

Add a `loading.tsx` at every major segment root, each composing the matching primitive(s) to approximate that
page's shell. Targets (exact list finalized in the plan after enumerating `src/app`):

- Heavy: `billing/subscription`, `billing/usage`, `billing/invoices`, `activity/runs`, `activity/audit`,
  `activity/approvals`, `knowledge/sources`, `knowledge/graph`, `knowledge/memories`,
  `automation/playbooks`, `automation/agents`, `automation/triggers`, `automation/event-sources`.
- Other major segments: `settings`, `security`, `developer`, and any other top-level org/workspace segment
  roots discovered during enumeration.

A segment's `loading.tsx` covers its own page during navigation; it is only effective once the layouts above it
are non-blocking (see D).

#### D. Layout de-blocking — `[orgSlug]/layout.tsx`

- **Keep** the auth/resolve awaits (`getSessionOrRedirect`, `resolveOrg`, `assertOrgMember`): they gate
  security/redirects and supply the org/workspace ids that `TenantProvider` and routing need synchronously.
- **Move** the non-critical display data — the org-switcher org list (the
  `orgUsers → organizations → subscriptions → plans` join), the workspace list, and `isLowBalance` — into an
  **async child component wrapped in `<Suspense>`** inside the layout. The layout shell (sidebar frame, nav
  chrome) then paints immediately and the data-dependent pieces (switcher contents, balance pill) stream in.
- Any consumer that currently reads this display data synchronously from the layout is refactored to receive it
  from the streamed child (or a context populated by it). The streamed child fetches concurrently
  (`Promise.all`) as today.
- **Risk:** shared layout affecting every org route. Mitigated by unit tests on the streamed child + e2e that
  asserts every major org route still renders its shell and data.

#### E. Heavy-segment streaming + de-waterfalling

General pattern per heavy page:
- `page.tsx` becomes a thin shell: cheap setup (params, tenant scope) + static header/tabs rendered immediately.
- Each data-dependent region is an **async server subcomponent** wrapped in
  `<Suspense fallback={<SectionSkeleton/>}>`. Sibling Suspense sections fetch **concurrently** (their awaits fire
  in parallel); a section needing multiple RPCs uses `Promise.all` internally.
- Existing try/catch graceful-degradation behavior is preserved inside each section.

Per page:
- **`knowledge/graph`** — split the 3 serial `invoke()`s into independent streamed sections (stats / approved
  edges / pending suggestions), each fetching in parallel. Worst waterfall removed.
- **`activity/runs`** — one streamed table section that fetches fanout list + executions via `Promise.all`
  (was serial); header + filters paint immediately.
- **`knowledge/sources`** — streamed table section for `connection.list`; header + "add source" affordance
  paint immediately.
- **`billing/subscription`** — collapse the two serial `Promise.all` batches; plan/subscription card, payment
  methods, and usage/credit sections stream independently. Tab nav paints immediately.
- **`automation/playbooks`** — currently mock/no-async → `loading.tsx` skeleton only (nav consistency); no
  streaming needed until wired to live data.
- **Other automation tabs (`agents`, `triggers`, `event-sources`)** — apply the streaming pattern **only where
  the page actually performs a server fetch** (checked per tab during implementation); otherwise skeleton-only.

### Testing strategy

Honors the coverage-ratchet gate: thresholds bumped only up to `floor(coverage − 2.5)`, never past 90, never
lowered.

- **Unit (Vitest):**
  - Skeleton primitives: correct structure (row/col/card counts) + `aria-busy`/`aria-label`.
  - Each `loading.tsx`: renders its skeleton without error.
  - Spinner components: `src` resolves to `/spinner/…`; `onError` hides the img and reveals the CSS fallback;
    `prefers-reduced-motion` respected; dark/light variant logic intact.
  - Layout streamed child: renders switcher/workspace/balance data on success; graceful state on fetch failure.
  - Each heavy-segment streamed section: success, empty, and error states render correctly.
- **E2E (Playwright, `apps/app/e2e/`):**
  - Per heavy segment: navigate and observe skeleton → content (throttle/intercept to make the skeleton
    observable). Screenshot the loaded success state.
  - **Mobile viewport route transition:** assert the transition spinner requests `/spinner/…` and receives
    HTTP 200 (not 404), and that no broken-image placeholder is present — the exact reported bug. Screenshot.
  - Screenshots written to a gitignored, deleted-and-recreated `apps/app/e2e/screenshots/`.

### Verification & handoff

- `pnpm build` → `pnpm kill && pnpm dev` (all servers up) → `pnpm gate` (lint/typecheck/coverage/tests/builds).
- `oxagen-run` proof: log in with `creds.json`, drive billing/activity/knowledge on a mobile viewport, screenshot
  skeleton→content and a working transition spinner.
- Dispatch **test-completeness-judge**; re-run until APPROVED.
- Commit the three commits on `feat/progressive-loading-ux`, leave **unpushed**. Mac pushes.
- File the Linear ticket(s) in `oxagen-v2` (one ticket = one PR; sub-issues for the three commits).

### Non-goals

- No per-segment `error.tsx` boundaries (separate concern; current try/catch degradation stays).
- No new dependencies. No data-store boundary changes. No contract/API/MCP changes (UI + RSC only).
- No replacement of the branded GIF spinner (CSS spinner is a fallback only).
- `automation/playbooks` is not wired to live data here.

### Risks

| Risk | Mitigation |
| --- | --- |
| De-blocking the shared `[orgSlug]/layout.tsx` regresses an org route | Unit test the streamed child; e2e across every major org route asserting shell + data render |
| Skeletons mismatch real layout → CLS | Skeletons mirror real dimensions/spacing tokens; visual check via screenshots |
| Streaming changes alter graceful-degradation behavior | Preserve existing try/catch inside each section; unit-test empty/error states |
| Coverage gate fails on new untested UI | New tests land with the code; thresholds ratcheted within the 2.5% headroom rule |
