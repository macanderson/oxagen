# Oxagen Brand Kit

A complete brand system built on the **Monaspace** superfamily and a violet-to-green
signature gradient. Marks, logotype, color tokens, type system, web fonts, and a
live component reference.

Open **`index.html`** in a browser for the full interactive guidelines (light/dark,
animations, every component). Everything else is production source.

## Contents

```
index.html                     # interactive brand guidelines + component reference
css/
  oxagen-theme.css             # Tailwind v4 + shadcn tokens (OKLCH, light + dark)
  oxagen-fonts.css             # @font-face for the 4 Monaspace families
fonts/                         # Monaspace woff2, Latin-subset (16 files, ~220 KB)
assets/                        # 21 SVG masters (see below)
README.md
```

## The mark

The **cored node O**: a ring that reads as the letter O and a graph node at once,
filled center, three radiating edges. It encodes the thesis — agents querying an
ontology — without being a literal diagram.

Geometry is locked as ratios of the ring radius **R**: ring stroke `0.227R`, core
`0.318R`, edge stroke `0.205R`, outer nodes `0.250R`; two upper edges at ±45° to
`1.45R`, one left edge to `1.82R`. The asymmetry is intentional and directional.

## Logotype

Set in **Monaspace Krypton**, lowercase. Krypton is the default — its mechanical
geometry rhymes with the mark. Three alternates are provided (Neon, Argon, Xenon)
for teams that want a different voice; pick one and stay consistent.

All wordmark SVGs are **outlined** (no live text), so they render identically with
no font installed.

## Type system — one superfamily, four roles

| Role | Family | CSS var | Use |
| --- | --- | --- | --- |
| Display | Monaspace Krypton | `--font-display` | Logotype, hero, big numerals, accents |
| Heading | Monaspace Xenon | `--font-heading` | Section headings, editorial authority |
| Body / Sans | Monaspace Neon | `--font-sans` | Body copy, UI labels, paragraphs |
| Mono | Monaspace Argon | `--font-mono` | Code, data, terminal, tabular figures |

Because every cut shares Monaspace metrics, they mix cleanly — the identity reads as
one engineered voice. Web fonts are Latin-subset woff2 (weights 400/500/600/700).

> Monaspace is licensed SIL OFL 1.1 (free for commercial use, embeddable). Ship the
> woff2 files as-is.

## Color

Signature gradient `#7182FF → #3CFF52`, two blend stops (`#5B9BE6`, `#45C49E`), and
ink/paper neutrals (`#0A0A0A`, `#F7F8FA`; dark surface `#0B1020`).

The gradient is **expressive** — reserve it for marks, hero, and key accents.
Functional UI runs on the neutrals plus a single violet primary. Semantic states:
violet primary, green success, amber warning, red destructive.

## Using the theme (Tailwind v4 + shadcn)

```css
/* app/globals.css */
@import "tailwindcss";
@import "./css/oxagen-fonts.css";
@import "./css/oxagen-theme.css";
```

`oxagen-theme.css` defines the full shadcn token contract (`--background`,
`--primary`, `--card`, `--ring`, sidebar tokens, chart tokens, …) in **OKLCH** for
both light (`:root`) and dark (`.dark`). It also maps the four type families in the
`@theme` block, so `font-sans`, `font-mono`, `font-display`, and `font-heading`
utilities resolve to the right Monaspace cut automatically.

**Retune the brand** by editing the `:root` and `.dark` blocks — every component
follows. Toggle dark mode by adding/removing `.dark` on `<html>` (shadcn convention).

```html
<button class="bg-primary text-primary-foreground rounded-lg px-4 py-2">Deploy</button>
<div class="bg-[image:var(--brand-gradient)] h-16 rounded-lg"></div>
```

## Assets (21 SVG masters)

Each is font-independent and theme-aware where noted.

- `logomark-{black,white,adaptive}.svg`
- `wordmark-{neon,argon,xenon,krypton}-{black,white,adaptive}.svg` (12)
- `horizontal-lockup-{black,white,adaptive}.svg` (Krypton)
- `vertical-lockup-{black,white,adaptive}.svg` (Krypton)

**Treatments:** `black` (#0A0A0A, on light), `white` (#FFFFFF, on dark), `adaptive`
(single file that flips with the OS theme via `prefers-color-scheme`).

## Generating web assets (favicons, OG, etc.)

The favicon/OG/touch-icon pipeline from the prior kit (`scripts/generate-assets.ts`,
using `sharp` + `png-to-ico`) works against these masters unchanged — point it at
`assets/logomark-*.svg` and `assets/horizontal-lockup-white.svg`.

## Don'ts

- Don't recolor individual mark elements; core, edges, nodes share one color (or one gradient).
- Don't stretch, rotate, or shear any asset.
- Don't set the wordmark in a non-Monaspace font.
- Don't place the black treatment on dark backgrounds — use white or adaptive.
- Don't overuse the gradient; it's the exception, not the default surface.
