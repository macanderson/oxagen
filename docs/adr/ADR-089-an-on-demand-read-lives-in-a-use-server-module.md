# ADR-089: An on-demand read lives in a `"use server"` module, beside the write

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** app
- **Related:** ADR-081 (app layers retired at the Mission Control cutover),
  `apps/app/ARCHITECTURE.md` §2 (the layer matrix), §3.2 (the kernel seam),
  §3.3 (the `DataSource` port),
  `apps/app/src/test/arch/layers.ts` (the matrix as a test),
  `apps/app/src/test/arch/probes/import-graph/kernel-read-no-directive.ts`,
  `apps/app/src/test/arch/port-callers.test.ts` (INV-17),
  `apps/app/src/test/arch/actions.test.ts` (INV-19)

## Context

`apps/app` has had one shape for a read since the cutover: a route resolves its
viewer, hands a `DataSource` port to a feature, and the port method calls
`kernelRead`. The layer matrix enforced it by admitting `@/server/kernel` into
`src/features/**` for `kernelWrite` alone, and only from a `"use server"`
module. A read from a feature was refused outright.

That shape assumes every read belongs to a route render. The Workspace settings
dialog (#2967, `features/shell/workspace-settings.tsx`) is the first surface
where that assumption does not hold, for three reasons at once:

1. **It is shell chrome, not a page.** The organization layout renders it above
   every page, so there is no route whose render is the natural moment to read.
2. **Its record is a live call to GitHub.** `list_installation_repositories`
   mints an installation token and pages GitHub's API. Hanging that off a layout
   charges every workspace page for a network round trip nobody asked for, and
   it destroys the one thing the panel most needs to do honestly — show a
   pending state while the list loads.
3. **The chrome has no workspace ctx.** The organization layout resolves an
   `OrgCtx`. Both new contracts are `scoped: true`. The workspace is in the URL,
   which only the client knows.

The options were: move `ShellStateProvider` out of `ShellClient` and render the
dialog from `[org]/[ws]/layout.tsx` — which leaves a dead opener on every
org-level page and still makes the GitHub call eagerly; add a `DataSource` port
method — which INV-17 rejects, because it fails any port method with no caller
under `src/features/**` or `src/app/**`, and an on-demand read has no such
caller by construction; or let the read happen when a person opens the panel.

## Decision

**`src/features/**` may import `kernelRead` from `@/server/kernel`, under
exactly the condition that already governs `kernelWrite`: only from a
`"use server"` module.**

The module resolves its own viewer with `requireViewer(org, ws)` and then reads,
exactly as a write does. Nothing else about the seam changes: the read still
goes through `kernelRead`, still carries a `PageKey`, still returns `Read<T>`,
and is still the only path to `invoke()`.

What stays refused:

- A read from a module with **no** directive. Pinned by the new probe
  `kernel-read-no-directive.ts`; the pre-existing
  `kernel-read-use-server.ts` probe flips to `expect: null`.
- A read not preceded by `requireViewer` (INV-19, `actions.test.ts`).
- Any other export of `@/server/kernel` from a feature.

A page or layout read is unchanged and still belongs in a `DataSource` port. The
port remains the default; this is the exception for a record that a route render
is the wrong moment to fetch.

## Consequences

- The Workspace settings dialog can draw a real loading state, and no workspace
  page pays for a GitHub round trip it will not use.
- The layer matrix now distinguishes *where* a read is made rather than *whether
  a feature may read*, which is the distinction that actually carries the design
  intent. `"use server"` remains the line, and it is the line worth keeping: it
  is what guarantees the module resolves a viewer rather than trusting a client
  argument.
- A future surface that wants an on-demand read gets a shape to copy instead of
  a reason to weaken the matrix further. The risk is that `"use server"` becomes
  a blanket excuse for reads that belong on a route; the mitigation is that
  INV-19 still demands `requireViewer` first, and a port method is still the
  cheaper thing to write when a route render *is* the right moment.
- `apps/app/ARCHITECTURE.md` §2's `src/features/<page>/**` row is updated in the
  same change, so the prose and the matrix-as-a-test cannot drift.

## Why this is an ADR rather than a comment

SCR-002: an architecture decision is recorded so it cannot be re-litigated from
scratch. The layer matrix is the app's load-bearing constraint, and loosening a
row of it is precisely the kind of change that looks like a small edit in a diff
and reads as an accident a year later. The comment in `layers.ts` says what the
rule is; this says why the alternatives were worse.
