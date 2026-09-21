# ADR-132: The mockup's CSS is the app's design of record

Status: Accepted
Date: 2026-09-20

## Context

ADR-130 chose the roadmap mockup's layout for the app. Three days of lanes then moved the app away from it without anyone deciding to. By 2026-09-20 the light theme had an ink primary button where the mockup has gold, an ink tab underline and an ink nav marker, grey bands behind every panel header and table header, a muted eyebrow, and four stat tiles that each page drew its own way. Every colour came from a house token, so no lint caught it: the drift was in which token a recipe named, not in a raw hex.

The mockup is `mockups/src/engine.css` in `macanderson/roadmap`, with `mockups/v2/src/style.css` on top of it for the pages v2 redesigned. Both share one palette block. The app cannot import that file: it is a different repository, and the app's colours must stay the house kit's tokens so a reskin reaches every frontend.

## Decision

The mockup's CSS is the design of record for the app's presentation, rule by rule. The app carries each rule as a named recipe in `apps/app/src/ui/control-styles.ts`, `table.tsx`, `route-tabs.tsx`, `badge.tsx` and `apps/app/src/app/globals.css`, and every recipe names the rule it draws in the comment above it. A page draws from the recipes and never around them.

What the recipes say, from the mockup:

- Gold is identity and never state. The one primary button on a screen is gold in both themes, the current tab is underlined in gold, the current nav item carries a gold inset, the organization avatar and the assistant mark are gold. State is a dot and a word in a tinted pill whose hue is a state hue.
- Headers are flat. A panel header, a table header and a dialog header sit on the panel fill with a hairline under them. Nothing draws a grey band.
- The eyebrow over an h1 names the scope, in gold as ink, in caps. Every app page has one.
- A stat tile is one recipe: caps term, 23px figure, muted note, on the panel fill.
- A table is 13px rows on the panel with a header in 10.5px caps and the dim ink.

`apps/app/src/test/arch/design-record.test.ts` (INV-32) holds the recipes to these rules and scans `src/` for a page that paints with the kit's ink primary or draws a tile by hand. A recipe changes with the rule and with that test.

Page-by-page browser comparison against the mockup remains the check for what a class list cannot say. The captures for this decision are under `verifications/mockup-fidelity/`.

## Consequences

A lane that wants a colour or a shape the mockup does not have changes the mockup first, then the recipe, then this record. A lane that needs a component the recipes do not cover adds the recipe with its rule named, not a one-off class list in the page.

The kit's `--primary` stays ink, because other frontends use it. The app overrides the button, tab and nav tokens in its own `globals.css`, in the light root, so the dark theme no longer carries a second copy of the gold overrides.

The mockup draws counts on the nav, a footer line with the agent count and the data plane, and notifications in the top bar. The app draws a nav count only where a read backs it (`fleetWaiting`, null today), and draws the footer line and notifications not at all, because no port backs them. A count nothing backs is a zero nobody can trust.
