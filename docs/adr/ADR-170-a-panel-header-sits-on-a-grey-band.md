# ADR-170: A panel header sits on a grey band, and the dark page is ink

- **Status:** Accepted
- **Date:** 2026-09-24
- **Owners:** app
- **Amends:** ADR-132 (the rule "Headers are flat", for panel headers only).

## Context

ADR-132 made the roadmap mockup's CSS the app's design of record. One of its
rules put every header flat on the panel fill: a panel header, a table header
and a dialog header, with a hairline under each and no grey band.

On 2026-09-24 Mac reviewed the Steering page and asked for three changes. A
panel header should sit on a light grey band in the light theme, and on a grey
a little lighter than the panel in the dark theme. The dark theme's page body
should be the ink, and the panel grey should appear only on panels. The same
review found the Steering library's list bar stacked: the search and each
filter select filled a full line of their own, five rows of controls above
the table.

## Decision

1. **`--panel-head` names the header band.** In the light theme it is
   `--ox-paper-hl` (#F4F4F5) over the white panel. In the dark theme it is
   `color-mix(in oklab, var(--ox-panel) 45%, var(--ox-hl))`, a step lighter
   than the panel (#18181B) and short of the row wash (#27272A), so a header
   never reads as a hovered row. The `panelHeader` recipe in
   `apps/app/src/ui/control-styles.ts` draws it with `bg-panel-head`, so every
   panel that uses the recipe takes the band.
2. **The footer, the table header and the dialog header stay flat.** This
   decision moves the panel header only.
3. **The dark page body is the ink.** `--app-panel-bg` is `var(--ink)` in the
   `.dark` block and in its `prefers-color-scheme` copy. Panels, tiles and
   drawers keep the panel grey.
4. **The list bar sizes its controls to their content.** The faceted list
   bar (`apps/app/src/ui/faceted-list-table.tsx`) no longer builds its
   controls on `inputBase`, whose `block w-full` belongs to a form field. The
   search takes the room left on the row, each select is as wide as its
   longest option with its own chevron, and Rows sits at the end.

`apps/app/src/test/arch/design-record.test.ts` holds items 1 to 3.
`apps/app/src/ui/faceted-list-table.test.tsx` holds item 4.

## Consequences

The app now differs from the mockup on panel headers. Per ADR-132, the mockup
should take the same band so the two agree again. Until it does, this record
is the rule for the app.

A panel drawn by hand, not through `panelHeader`, keeps a flat header. Such a
panel should move to the recipe rather than copy the class.
