# ADR-298: A text class follows the kit's type role, not the mockup's pixel size

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** app shell, packages/ui
- **Decided by:** the agent, under SCR-002, on the maintainer's report that
  the agent, run and work item headers draw too small (#5471)
- **Amends:** the mapping rule in #5292, which assigned each class the pixel
  size it drew before #5257 and snapped it to the step at or below it.
- **Related:** ADR-226 (the kit owns type, the mockup owns layout), #5256 (the
  14px base), #5292 (the text scale map), `oxageninc/brand`
  `theme/theme.schema.json` (the role of each step),
  `apps/app/src/test/arch/type-scale.test.ts` (INV-36),
  `tools/scripts/type-audit.mjs`.

## Context

The kit's app scale has seven steps at the 14px base: 30, 24, 20, 16, 14, 12
and 10px. Tailwind's `text-xs` to `text-3xl` read them in order, so `text-xs`
is 10px and `text-sm` is 12px (#5292). The kit's schema gives each step a
role:

| Step | Class | Size | Role |
|---|---|---|---|
| body | `text-base` | 14px | Running text, a button, an input, a menu item, a table cell |
| micro | `text-sm` | 12px | A label, a badge, a timestamp, a table header |
| 2xs | `text-xs` | 10px | A dense table header, a small badge, a menu group label, a chart axis |

#5292 did not assign classes by that table. It kept the pixel size each class
drew from the mockup and snapped it to the nearest step at or below it. The
mockup's most used sizes are 11px (49 rules), 12.5px (76) and 13px (61), and
none of them is a step. Its 11px eyebrows, 10.5px table headers and 11.5px
chips became 10px. Its 13px descriptions, table cells and tabs became 12px.
The agent page's h1 and the run page's h1, both stock `text-lg` at 18px before
#5292, became 16px, while the plain page header and the work item header draw
their h1 at 24px.

The result is text under every enterprise system's floor. IBM Carbon's
productive set and Atlassian's tokens start at 12px, and Atlassian raised its
floor from 11px to 12px for legibility. Shopify Polaris draws 12px only for a
caption or a timestamp of a few words. Material 3 keeps 11px for an uppercase
label alone. At the time of this decision the app has 362 class sites and
three stylesheet rules at 10px, 686 running text sites under the base, and
page h1s at two sizes.

## Decision

A text class in `apps/app` and `packages/ui` follows the role of the element
it sits on, as the kit's table gives it. The mockup's pixel size decides
nothing about the class. ADR-226 already gives type to the kit and layout and
behavior to the mockup; this decision applies it to the class a port writes.

- Running text, a table cell, a property value, a button, an input and a menu
  item take `text-base`.
- A label, an eyebrow, a chip, a badge, a timestamp, a stat label and a table
  header take `text-sm`.
- `text-xs` draws a chart axis, a dense table header, a small badge or a menu
  group label, and nothing a person reads as a sentence.
- Every page's one h1 takes `text-2xl`, the h2 step. The kit's h1 step (30px)
  is for a display heading, and the app has none. The agent key, the run name
  and the record label are page h1s and draw at the same step as the page
  header and the work item.
- Code and data in the mono face take `text-sm`, the kit's code step, or the
  base.

`node tools/scripts/type-audit.mjs` reads every size in both trees, resolves
it from the kit's tokens, gives each site the role its element implies, and
lists every site under its role's floor. The report is the backlog for this
decision. It is not a gate: INV-36 already fails a size written by hand, and
the role of a bare `span` or `div` is a judgment the script marks `unknown`.

## Consequences

- #5471 moves the shared recipes (`eyebrow`, `statTerm`, `statNote`,
  `runStatTerm`, `runStatNote`, `linkChip`, `kvTerm`, `kvList`), the table
  cell and header rules, the transcript skins, the five page headers and the
  shared panel eyebrow. The audit lists what remains, and the residue issue
  for #5471 carries it.
- A later port of a mockup rule writes the class for the element's role. A
  mockup `font-size: 13px` on a table cell is `text-base`, and on an eyebrow
  it is `text-sm`.
- The kit's leading values put every step's line box off the 4px grid (14px
  times 1.5 is 21px, 12px times 1.4 is 16.8px). Carbon, Atlassian and Polaris
  set each line box on the grid (14/20, 12/16). That is a kit decision, and
  the audit prints the table so the maintainer can take it to `oxageninc/brand`.
- The kit has no 13px step. The mockup's 13px rules now read as 14px in the
  app. If the maintainer wants the denser 13px tier that Polaris, Linear and
  macOS draw, that is a step in the kit, not a class in the app.
