# Oxagen Brand Assets

The Oxagen logomark, wordmark, and lockups, plus an executable pipeline that
generates every raster asset a modern web app needs.

The mark is the **cored node O**: a ring that reads as the letter O and as a
graph node at once, with a filled center and three radiating edges terminating
in smaller nodes. It encodes the product thesis directly, agents querying an
ontology, structured context as a first-class object.

## Contents

```
assets/                         # vector masters (source of truth)
  logomark-{black,white,adaptive}.svg
  wordmark-{black,white,adaptive}.svg
  horizontal-lockup-{black,white,adaptive}.svg
  vertical-lockup-{black,white,adaptive}.svg
scripts/
  generate-assets.ts            # rasterizes masters into web assets
README.md
```

## The four masters

| Master | Use |
| --- | --- |
| `logomark` | App icon, favicon, avatar, any square or standalone mark. |
| `wordmark` | Inline text contexts, nav, docs headers, where the mark is redundant. |
| `horizontal-lockup` | Default lockup. Site headers, README, slide footers, email signatures. |
| `vertical-lockup` | Square or centered space. Splash screens, merch, social avatars. |

## Color treatments

Three treatments per master. No brand color is applied yet, this is the
monochrome system.

- **black** — `#0A0A0A` ink. Use on light surfaces.
- **white** — `#FFFFFF`. Use on dark or photographic surfaces.
- **adaptive** — single file that flips with the OS theme via
  `@media (prefers-color-scheme: dark)`. Renders ink in light mode, white in
  dark mode. Use anywhere the background follows the system theme (web UI,
  in-app, GitHub READMEs that respect the theme).

> The adaptive file uses `currentColor` driven by a `:root` color rule. Embed it
> inline (`<svg>` in the DOM) or via `<img>`; both honor the media query.

## Wordmark typography

The wordmark is **Geist Mono Medium**, lowercase, set tight (`-0.5px` tracking).
Glyphs are **converted to outlines** in every master, so the files render
identically with no font installed. To re-typeset (size change, weight change),
regenerate from Geist Mono Medium, do not substitute another mono.

Lowercase and monospace are deliberate, the mark should read as something you
type into, not a corporate logotype.

## Geometry (logomark)

Locked proportions, expressed as ratios of the ring radius **R**:

| Element | Value |
| --- | --- |
| Ring radius | `R` |
| Ring stroke | `0.227 R` |
| Core radius (filled center) | `0.318 R` |
| Edge stroke | `0.205 R` |
| Outer node radius | `0.250 R` |
| Upper edges | two, at ±45° to the upper right, length to `1.45 R` from center |
| Left edge | one, horizontal, length to `1.82 R` from center |
| Outer nodes | centered at `1.64 R` (diagonals) and `2.05 R` (left) |

Edge endcaps and edge nodes are round. The asymmetry (two right, one left) is
intentional and directional, it reads as flow out of the node. Do not
symmetrize, recolor the core, or add edges.

## Clear space and minimum size

- **Clear space**: keep a margin equal to the core diameter on all sides of any
  lockup or mark.
- **Minimum size**: logomark `16px`; horizontal lockup `120px` wide; vertical
  lockup `96px` wide. Below `20px`, prefer a simplified favicon (ring + core,
  no outer nodes) if legibility suffers, the generator's small PNGs are tuned
  but test in context.

## Don'ts

- Don't stretch, rotate, or shear any asset.
- Don't recolor individual elements (core, edges, nodes must share one color).
- Don't add gradients, shadows, or glows to the monochrome masters.
- Don't re-typeset the wordmark in a different font.
- Don't place the black master on dark or busy backgrounds, use white or adaptive.

## Generating web assets

`scripts/generate-assets.ts` rasterizes the masters into a complete favicon and
social-asset set, then writes a web manifest and a copy-paste `<head>` snippet.

### Install

```bash
pnpm add -D sharp png-to-ico tsx
```

### Run

```bash
pnpm tsx scripts/generate-assets.ts                 # → ./public
pnpm tsx scripts/generate-assets.ts --outdir static # custom output dir
```

### Output

| File | Purpose |
| --- | --- |
| `favicon.ico` | Multi-resolution (16/32/48), legacy + universal. |
| `favicon-{16,32,48,64,96,192,512}x….png` | Modern PNG favicons. |
| `favicon-32x32-dark.png` | Dark-theme tab icon (white mark). |
| `apple-touch-icon.png` | 180×180, opaque ink field, iOS home screen. |
| `icon-192.png`, `icon-512.png` | Android / PWA. |
| `icon-maskable-512.png` | Maskable, 20% safe-zone padding for launcher cropping. |
| `site.webmanifest` | PWA manifest wiring the icons. |
| `og-image.png` | 1200×630 Open Graph / Twitter card, on-brand. |
| `head-snippet.html` | Drop-in `<head>` tags for all of the above. |

### Wiring it up (Next.js App Router)

Place outputs in `public/`, then either paste `head-snippet.html` into your root
layout `<head>`, or use the metadata API. The `favicon.ico`,
`apple-touch-icon.png`, and `icon-*.png` names are recognized conventions, so
Next will pick most of them up from `app/` automatically if you move them there.

## Regenerating the masters

The masters are generated from Geist Mono outlines and locked geometry. If you
change proportions or typography, regenerate all twelve masters together so the
three treatments and four lockups stay in parity, then re-run the asset script.
