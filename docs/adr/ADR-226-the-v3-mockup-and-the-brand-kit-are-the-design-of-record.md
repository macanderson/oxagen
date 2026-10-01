# ADR-226: The v3 mockup and the brand kit are the design of record

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** app
- **Supersedes:** ADR-130, ADR-132, ADR-170
- **Related:** issue #4734, ADR-221 (shadcn `base-maia` on Base UI),
  `apps/app/ARCHITECTURE.md` INV-16, INV-17 and INV-32.

## Context

Three ADRs sent an agent to the rev1 Mission Control mockup. ADR-130 took the
layout of `mockups/missioncontrol.html`. ADR-132 made `mockups/src/engine.css`
the app's design of record, rule by rule. ADR-170 amended ADR-132 for panel
headers. Roadmap #234 removed both files on 2026-09-28 and made the v3 mockup
the only one, at `oxagen-roadmap/mockups/`. Its README calls it "the design of
rev1". Here rev1 is the release the app ships. The rev1 mockup is the deleted
design.

Each file that told an agent where to look named the mockups at `origin/main`
or a file that no longer exists. A slice read whatever main held that day.

The v3 mockup and the house brand kit also disagree on type. The mockup sets
Aeonik, Aeonik Fono and Aeonik Mono, with Space Grotesk for the h1 and heroes.
The kit ships Space Grotesk for the display and h1 to h3, Geist for body and
UI, and Monaspace Neon for code, and the app loads the kit's faces.

## Decision

### Two sources of record

1. **The v3 mockup sets layout and behavior.** It decides what a page shows,
   where each thing sits, which states it has, and what a control does. Read
   it at the pin below: `mockups/README.md`, `mockups/index.html` built from
   `mockups/src/` (`v3.css`, `shared.css`, and the area modules), and the demo
   record in `mockups/fixtures/`.
2. **The brand kit sets tokens, type, marks, and components.** The kit is
   `macanderson/oxagen-brand`. `tools/scripts/sync-brand-assets.mjs` copies its
   `tokens/house-tokens.css` to `packages/ui/src/styles/house-tokens.css`, and
   `pnpm check:brand` fails on drift. `packages/ui/src/styles/globals.css` and
   `house-tailwind.css` map those tokens to the semantic names the app uses,
   and `apps/app/src/app/globals.css` is the app's one token map. The kit has no
   component library. A component is shadcn's `base-maia` on Base UI, copied
   into `apps/app/src/ui/` and drawn on the kit's semantic tokens, as ADR-221
   decides. ADR-221 stays in force.

### The pin

The mockup is read at one commit:

```
oxageninc/roadmap @ bfd267fc88679fa8a88bc6a185112850c81e6581, path mockups/
```

This is the last `main` commit that touched `mockups/` (roadmap #283,
2026-10-01 03:00 UTC). Every other file that sends an agent to the mockup
points here instead of repeating the SHA.

Amended 2026-09-29: the pin moves from roadmap #261 (`8a4c0a45`) to roadmap
#267. The new commit fills light-theme popups at 55% over a 16px blur, as
ADR-221 §3 now states. The dark theme keeps 70% over 40px.

Amended 2026-09-29 (later): the pin moves from roadmap #267 (`ce2f80de`) to
roadmap #273 (`41cb7205`). The new commit folds the Tools area into Agents:
one Agents header over five tabs (Agents, Tool servers, Policies, Runtimes,
Off switches), with Connect an agent as its one primary action, and a server
page at `agents/<server>`. It also carries the Agent work phase pages of
roadmap #269 and #270.

Amended 2026-10-01: the pin moves from roadmap #273 (`41cb7205`) to roadmap
#283 (`bfd267fc`), in the repository's new home, `oxageninc/roadmap`. Mac
decided on 2026-09-30 that the mockup draws the app's agent pages (roadmap #276):
the Agents tab is the app's four tiles and its agents table with the Composition
and Operations columns, an agent opens its own page at `agents/<key>/<tab>` with
the app's seven tabs, and every agent avatar carries its harness mark in the
lower-left corner, as `AgentAvatar` draws it. The new commit also carries the kit
wordmark and installable pages (roadmap #274), the parity audit's page registry
and prompts (#275), the organization steering repo named `oxagen-config` (#277),
the Phase 1 Work lifecycle and its error states (#278), and the house brand
synced from `oxageninc/brand` (#283).

To read a file at the pin, run
`git -C ../oxagen-roadmap show bfd267fc88679fa8a88bc6a185112850c81e6581:mockups/README.md`,
or open `https://github.com/oxageninc/roadmap/tree/bfd267fc88679fa8a88bc6a185112850c81e6581/mockups`.

Moving the pin is a permitted amendment to this ADR. A pull request changes the
SHA and the date on the pin line, and names the mockup changes the new commit
brings. It needs no new ADR.

### Where the two disagree

The kit wins on tokens, type, and marks. The mockup wins on layout and
behavior.

- **Type.** The app keeps the kit's faces until the kit adopts Aeonik. Geist
  sets every heading and every line of text, and Monaspace Neon sets code.
  Space Grotesk sets only the Oxagen and stella wordmarks. A slice ports the
  mockup's type roles (which text is body or mono) and draws a display role in
  Geist. The amendment of 2026-09-29 below has the reason.
- **Copy.** The mockup sets layout and behavior, not wording. A heading,
  button, caption, or hint ported from the mockup follows `CLAUDE.md` under
  Labels and headings, and a label that breaks that rule is renamed in the
  port.
- **Colour.** A mockup hex that the kit has no token for is not copied. The
  slice uses the nearest kit token, or asks the kit for a new one.
- **Radius and control sizes.** ADR-221's `base-maia` scale stays. The mockup
  draws a 12px card and panel radius, and the app draws `rounded-2xl` on
  `--ui-radius`.

### Rules the app keeps

These rules from ADR-132 and ADR-170 hold in the v3 mockup at the pin. INV-32
checks the recipes that draw them:

- Gold is identity. The primary button, the two gold avatar tones, and the
  eyebrow draw in gold, and v3 marks the selected nav item with a gold inset.
  No component paints with shadcn's ink `primary`.
- Every app page names its scope in an eyebrow over the h1.
- A panel header sits on the `--panel-head` band: `--ox-paper-hl` in light, and
  a step lighter than the panel in dark. The footer and the table header stay
  flat on the panel.
- The dark page body is the ink.
- The stat tile is one recipe: a caps term over a figure in tabular numbers.
  No page draws a tile by hand.
- A secondary button at rest sits on the panel fill.

### Where the app differs from v3 today

INV-32 holds these as the app's own rules until a slice ports the v3 version:

- **Page tabs.** v3 draws page tabs as a muted track with one raised tab, and
  keeps the gold underline for tabs inside a dialog. The app's route tabs still
  draw the gold underline.
- **Table cells.** The app cuts an overlong cell with an ellipsis and a hover
  card (#4665). v3 draws no ellipsis on `td`.

### Scope

The mockup README's Cuts and Decisions sections at the pin decide what the app
builds and what it leaves out. ADR-130's list of excluded features (definition
of done, witness, proof, credit scores, and trust scores) no longer applies. The
v3 mockup has a done record on the work item, and session 4 in `BUILD-CHUNKS.md`
builds a Proof tab.

ADR-130's spend decisions stay in force: Spend leads with attributed spend and
recorded behavior, a missing cost stays missing, no figure sums two currencies,
and an estimate of avoidable cost is not a realized saving. Its two correction
paths also stay: a context PR through the context-record wizard, and a code
change as an editable request to Stella that sends nothing until the operator
sends it.

### Retained UI code

ADR-130 let UI code stay in the tree without a production caller when
`DEREGISTERED.md` registers it and each retained export carries the
`@deregistered` tag, which knip reads. That rule stays. Nothing is retained
today: the Run page restored the Chain and seal tab, the replay grade badge,
Fork replay, and Bisect (ADR-166), so every port has a caller (INV-17) and
knip keeps its empty baseline (INV-16).

### INV-32

`apps/app/src/test/arch/design-record.test.ts` holds the recipes in
`apps/app/src/ui/control-styles.ts` and `apps/app/src/app/globals.css` to the
rules above. It also fails when a file under `apps/app/src` writes a colour or
a font family the kit does not supply:

- a raw hex, `rgb()`, `hsl()`, `oklch()`, `color()`, or other colour function;
- a `color-mix()` or `light-dark()` that mixes anything but `var(--…)` tokens,
  `transparent`, and `currentColor`;
- a Tailwind default-palette class such as `bg-blue-500` or `text-white`;
- a `font-family` or `fontFamily` not drawn from a `var(--…)` token, a `font`
  shorthand that does not end in one `var(--…)` token, a `font-serif` or
  `font-[…]` family class, `next/font`, or `@font-face`.

The token map files (`apps/app/src/app/globals.css` and
`apps/app/src/ui/control-styles.ts`) are exempt. A short allowlist in the test
names each other file that must write a literal, with the reason: the theme and
manifest colours, third-party marks, the Stella mark's SVG fills, the harness
transcript skins, and a standalone HTML response. A new entry needs a reason in
the same line.

## Consequences

- A slice agent reads this ADR first, then the mockup at the pin, then the kit's
  tokens. `apps/app/ARCHITECTURE.md`, the root `CLAUDE.md`, and the `mc-*`
  commands and workflows send it here.
- A change to a page's layout or behavior starts in the mockup, then moves the
  pin, then lands in the app. A change to a colour, a font, or a mark starts in
  the kit, then syncs.
- Captures under `verifications/mockup-fidelity/` compare a page with the
  mockup at the pin. A capture from an older commit shows the old design.
- The Aeonik gap stays open until the kit decides. INV-32 fails on an Aeonik
  `font-family` written in the app, so the kit has to ship it first.
- ADR-130, ADR-132, and ADR-170 are superseded. Their rules that still hold are
  restated above.

## Amendment of 2026-09-29: one face and plain labels

Mac set two rules on 2026-09-29 after the Steering page shipped two headings
in Space Grotesk and two labels ported from the mockup, "Everything written
down" and "Who receives it".

- **One face.** Space Grotesk is banned everywhere except the Oxagen wordmark,
  the stella wordmark in the assistant launcher, and line 1 of the oxagen.sh
  hero. Geist sets every other heading and every line of text in every app.
  The kit still maps h1 to h3 to Space Grotesk in `house-tailwind.css`, which
  the sync keeps byte-identical. `packages/ui/src/styles/globals.css` therefore
  sets `--font-display` to Geist in an `@theme` block after the kit's import,
  and keeps Space Grotesk under `--font-wordmark` for the marks alone. INV-32
  fails when a file under `apps/app/src` names `--ox-font-display`,
  `--font-wordmark`, or Space Grotesk outside a comment. The kit should adopt
  the same rule. Until it does, this override is the app's record.
- **Plain labels.** The mockup's wording is not the design of record. The rule
  in `CLAUDE.md` under Labels and headings governs every heading, button,
  caption, and hint, including one a slice ports from the mockup.
