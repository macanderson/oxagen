# ADR-NEW: A row of route tabs is a tab widget

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** app
- **Related:** issue #3995, `apps/app/src/ui/route-tabs.tsx`,
  `apps/app/src/ui/tab-row.tsx`, `apps/app/ARCHITECTURE.md` §1.2, ADR-226.

## Context

In `apps/app` a tab is a URL segment or a query value (`ARCHITECTURE.md`
§1.2), so a reload or a shared link keeps it. Each tab is a link to its own
route.

By 2026-09-30 the app drew those rows three ways:

- `RouteTabs` drew a `nav` of links marked `aria-current="page"`. Repositories
  and Spend used it that way.
- `RouteTabs` with its opt-in `tablist` prop added `role="tablist"`,
  `role="tab"`, and `aria-selected`, with no `aria-controls`, no panel, no
  roving focus, and no arrow keys. Audit, Organization, the API keys
  workspace picker, and the Agents page used it.
- Run, Steering, MCP Studio, and one agent's page drew their own rows by
  hand. Steering kept the whole keyboard contract. Run and Studio named a
  panel but had no arrow keys. One agent's page had neither. The Tool servers
  views drew a row of links with `aria-current`.

A screen reader heard a tab widget on most pages, and most of those pages did
not keep the keyboard contract the widget promises. The v3 audit prompts
judge tab rows on that contract.

Two readings were defensible. A row of links that load routes is navigation,
and `aria-current="page"` is the pattern for it. Or the row is a tab widget
whose tabs happen to be links, and the page under it is the panel.

## Decision

Mac decided on 2026-10-01: every row of route tabs is a tab widget, built once
in `RouteTabs`. Every tab row in the app draws through it, and the `tablist`
prop is gone.

- **Markup.** A `div[data-tab-row]` scrolls the row. Inside it, a
  `div[role="tablist"]` carries the row's label. Each tab is a link with
  `role="tab"` and `aria-selected`, and `data-tab` carries the tab's name.
- **One selected state.** A tab carries `aria-selected` and no
  `aria-current`. The selected style keys on `aria-selected`, as engine.css
  keys `.tab[aria-selected]`, and `design-record.test.ts` pins it.
- **Keyboard.** The selected tab is the row's one stop in the tab order
  (`tabindex="0"`, every other tab `-1`). ArrowLeft and ArrowRight move focus
  and wrap at each end. Home and End move to the first and last tab. Focus
  moves without following a link, so the arrow keys never load a route. Enter
  follows the focused tab's link, and Space does too. A key pressed with Alt,
  Control, or Meta stays the browser's, so Alt+ArrowLeft still goes back.
- **A row with no tab selected.** Organization renders Cost centers and
  Single sign-on under its row with no tab selected. The first tab then takes
  the tab stop, so the row stays reachable, and the panel has no label.
- **Panels.** Only the selected tab's panel is on the page. The selected tab
  names it in `aria-controls`, and the panel (`RouteTabPanel`) takes that tab
  as its label through `aria-labelledby`. No other tab names a panel, because
  a reference to a panel the page did not draw points at nothing.
- **Still links.** Each tab keeps its `href`, so a middle click opens it in a
  new browser tab and the address bar names the tab.
- **Phone.** The row scrolls sideways and snaps each tab to its start
  (`src/ui/phone.css`). When the selected tab changes, the row scrolls it into
  view. Only the row scrolls, never the page.
- **Views inside a tab.** The Tool servers views are a second tablist inside
  the Agents page's panel. They use the same component with the `pill` look,
  so they read as part of the tab.

The keyboard lives in a `"use client"` module of its own (`tab-row.tsx`).
`route-tabs.tsx` has no directive, so a server component can still read its
recipes (`tabLink`, `tabCount`) and render `RouteTabs` and `RouteTabPanel`.

## Consequences

- A tab's role is `tab`, not `link`, so a test finds it with
  `getByRole("tab")`. Each caller's component test asserts the tablist, the
  selected tab, and the panel it names.
- A new page with tabs renders `RouteTabs` with a `panel` id and wraps its body
  in `RouteTabPanel` with the same id. A hand-drawn tab row is a regression.
- Steering's own keyboard code is gone. Steering keeps its behavior through
  `RouteTabs`, and gains the modifier-key rule.
- The rev1 audit prompts' check 12 ("Tabs use `role=tablist/tab` with
  `aria-selected`") and the v3 `steering.audit-prompt.md` tab check hold for
  every row.

## Alternatives considered

- **Keep links.** Draw every row as a `nav` of links with
  `aria-current="page"`, and amend the audit prompts to accept it. This is
  the smaller change and matches what each link does. Mac chose the tab
  widget, so the design's tab rows and the app agree, and a keyboard user
  moves along a row of eight tabs with one key instead of eight.
- **Automatic activation.** Load the route as focus moves. Each tab is a
  route load, so moving across a row would load every page on the way.
  Manual activation keeps focus moves free.
