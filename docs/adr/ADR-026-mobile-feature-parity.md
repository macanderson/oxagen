# ADR-026 — Mobile feature parity is law, enforced by a manifest gate

- **Status:** Accepted
- **Date:** 2026-07-08
- **Owners:** App
- **Relates to:** the UI Capability Parity law (CLAUDE.md, `check:ui-parity` / `apps/app/capability-ui-map.json`)

## Context

`apps/app` is a responsive Next.js surface, and Tailwind makes it trivial to
hide any element below a breakpoint (`hidden md:block`, `hidden sm:flex`,
`max-md:hidden`, …). That ease is also the risk: a desktop-first contributor
reaches for `hidden md:block` to make a cramped layout fit, and a whole
capability — a settings section, a data table, a toolbar action, a live
status readout — quietly disappears for every mobile user, with nothing in
CI or code review calling it out. `check:ui-parity` already
guarantees a capability has *some* working page in the app; it says nothing
about whether that page still works once the viewport narrows.

An audit of the current `apps/app/src` tree found 29 occurrences of this
shape. The large majority are legitimate: a desktop sidebar re-presented as a
bottom-sheet nav, a labeled table header re-presented as stacked per-row
fields, an icon+label button that drops its label below `sm` but keeps its
icon, `aria-label`, and `onClick`. A handful were not — most notably an
`AgentBottomBar` wrapped in `hidden md:block` that directly contradicts its
own doc comment describing mobile-visible behavior, and a coding-agent
trace/workspace-context rail with no mobile presentation at all. Those are
exactly the failures this law exists to catch.

## Decision

**Every capability operable on desktop in `apps/app` must be operable on
mobile viewports.** Hiding a capability from mobile is not a layout
convenience; it is a product decision that requires a registered,
scrutinized justification. Re-presenting a capability differently on mobile
("reflow") is the preferred and default pattern, not an exception.

1. **One-thumb, bottom-zone navigation is the mobile standard.** Primary
   navigation, section switching, and frequent actions belong within reach
   of a thumb at the bottom of the screen (`MobileBottomBar`, bottom
   `Sheet`s, sticky bottom section-switchers), not a top-left hamburger or a
   hover-dependent sidebar. Touch targets are **≥44px** (`min-h-11
   min-w-11` or larger), matching Apple/Android HIG guidance for reliable
   thumb accuracy.

2. **Hiding requires a registered justification, and only two categories
   qualify:** `security` (the capability is deliberately withheld on mobile
   for a security reason — e.g. a control that must not be operable from an
   unmanaged device) or `performance` (the cost of building or rendering the
   mobile equivalent is genuinely outsized relative to the capability's
   value). Nothing else — not "no time," not "looks better on desktop," not
   "nobody uses this on mobile" as an assumption — clears the bar. The
   justification is a first-class, reviewable artifact, not a code comment
   that can rot silently.

3. **The manifest is `apps/app/mobile-parity.json`.** Every Tailwind pattern
   that hides an element at a breakpoint must have a matching entry:
   - `kind: "reflow"` — the default. Requires `equivalent` (≥20 chars)
     describing the actual mobile-equivalent surface. A vague equivalent
     ("shown elsewhere") does not satisfy this; it must name the component
     or page and how it presents the same capability.
   - `kind: "hidden"` — the capability is genuinely unavailable on mobile.
     Requires `reason` (`"security"` or `"performance"`), a `justification`
     (≥120 chars — long enough to force a real argument, not a one-liner),
     and `approvedBy`.

4. **The gate is bidirectional, like `check:ui-parity`'s forward/reverse
   split.** An unregistered hiding pattern is a violation (the feature was
   hidden without anyone accounting for it). A manifest entry that no
   longer matches any pattern is *also* a violation ("stale" — the code
   changed and the manifest is now lying about the current state), unless
   marked `pending: true` for an entry registered ahead of an in-flight
   change on a parallel branch, which downgrades to a `::warning::` instead
   of failing.

5. **Enforced by `pnpm check:mobile-parity`**, wired into the `gate` script
   immediately after `pnpm check:ui-parity` — UI capability parity and
   mobile feature parity are the same law applied to two axes (does it
   exist in the app at all; does it survive a narrow viewport), and belong
   next to each other in the pipeline.

## Consequences

- A contributor who reaches for `hidden md:block` to solve a layout problem
  now has to either build the mobile reflow (preferred), or write a
  justification that survives review. This is deliberate friction: the
  friction is cheaper than a silently mobile-broken feature reaching users.
- The manifest is a living audit trail of every deliberate mobile
  compromise the product has made, reviewable in one file rather than
  scattered across component comments (or, worse, not documented anywhere).
- Two genuine gaps found during the initial audit (the `AgentBottomBar`
  contradiction and the coding-agent trace/context rail) are intentionally
  left **uncovered** in the manifest rather than papered over with an
  invented justification — the law's own bidirectional design means an
  honest baseline can start with real, visible violations rather than a
  fabricated clean slate.

## Alternatives considered

- **Lint rule flagging any `hidden` + breakpoint-visible pair.** Rejected as
  the sole mechanism: a lint rule can only ban or allow, it cannot capture
  *why* a specific hide is acceptable or what the mobile equivalent is. The
  manifest gives the exception a body, not just a suppression comment.
- **Code review alone.** Already the status quo, and is exactly what missed
  the 29 occurrences audited here. A gate that runs in CI and fails on an
  unregistered pattern is strictly stronger than "reviewers should notice."
