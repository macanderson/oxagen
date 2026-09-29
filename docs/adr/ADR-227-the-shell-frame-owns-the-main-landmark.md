# ADR-227: The shell frame owns the main landmark

- **Status:** Accepted
- **Date:** 2026-09-29
- **Owners:** app
- **Related:** issue #4053, issue #4036, `apps/app/ARCHITECTURE.md` INV-34,
  `apps/app/src/test/arch/loading-landmarks.test.ts`.

## Context

Every organization and workspace page drew its own `<main id="main">`, and so
did every `loading.tsx` fallback, the billing layout, the shared page states,
the register gate, and the denied workspace. The skip link targets `#main`.

Next.js streams a route with a `loading.tsx` in two parts. The fallback renders
first. The page then arrives in a hidden `<div hidden id="S:0">` after the
fallback, and React swaps the two a moment later. Between those two events the
document held two `main#main` elements. Playwright's strict mode refused the
second one, and the `page-load` e2e job failed on it (runs 35970093793 and
35968922970). The first fix waited for the count to settle at one. That made
the test tolerant of a page that was still wrong: a screen reader and the skip
link met two main landmarks while the page streamed.

Mac chose option 3 on #4053 on 2026-09-29: keep the fallback's `<main>` out of
the document once the page body mounts, so the page is correct and the test is
strict.

## Decision

1. **The shell frame renders the one main landmark.** `ShellFrame` in
   `src/features/shell/shell-frame.tsx` renders `<main id="main">` around the
   page slot. It sits above the organization layout's `<Suspense>`, so the
   landmark is in the document from the first byte and survives every
   fallback-to-page swap.
2. **Nothing under the shell renders a main of its own.** A page, a layout, a
   `loading.tsx` fallback, and a shared page state (`PageSkeleton`,
   `RouteError`, `PageNotFound`, `PageDenied`) render their body inside the
   shell's main. None renders a `<main>`, `role="main"`, or `id="main"`.
3. **Five modules own a main, and each stands outside the shell.** They are
   `ShellFrame`, the onboarding gate (`src/features/onboarding/ui/gate-shell.tsx`),
   the auth shell (`src/ui/auth-shell.tsx`), the root `not-found.tsx`, and
   `global-error.tsx`. The onboarding gate's step, the sign-in pages, and the
   two root error pages render outside `ShellFrame`, so each keeps its own
   landmark.
4. **An arch test holds the rule.** `loading-landmarks.test.ts` walks each
   production `.tsx` file's JSX and lists every module that renders a main
   landmark. The list must equal the five owners. The test reads the syntax
   tree, so a comment or a string that names `main#main` does not count.

## Consequences

- The skip link and the landmark have one target at every moment of a
  streamed load. `page-load.spec.ts` counts `main#main` under the shell once,
  without a retry, and fails on a second one.
- The shell's `main#main` rules in `src/app/globals.css` (the 1500 px width,
  the page padding, and the stagger animation) now apply to the loading
  fallbacks and the page states too. The fallbacks dropped their own
  `mx-auto`, `max-w-*`, `px-4`, and `py-10` classes, so the skeleton and the
  page it gives way to share one box and the body no longer jumps.
- The steering-repo health banner and the register gate dropped their own
  side padding, which the shell's main now supplies.
- The audit pages keep their `group/audit` wrapper as a `display: contents`
  div. The stagger animation does not reach through `display: contents`, so the
  audit sections appear without it.
- A new page returns its body as a fragment or a single element. A page that
  needs a landmark of its own is a page outside the shell and joins the owner
  list in the arch test, with a comment that says why.
