# Aeonik Font Assets

> **ACTIVE — the Aeonik variable fonts are self-hosted and wired in.**
> The variable-font binaries (`Aeonik-VF.woff2`, `Aeonik-VF-italic.woff2`,
> `AeonikFono-VF.woff2`, `AeonikMono-VF.woff2`) live in this directory and are
> referenced by `aeonik.css`, which is `@import`-ed by
> `packages/ui/src/styles/globals.css`. Because the `src` url()s are
> bundler-relative, each app emits the woff2 from this one shared location —
> no per-app `public/fonts/` copies. Each font stack keeps a system fallback,
> so the build and runtime stay functional even if a binary is missing.
>
> These are **licensed assets** (CoType Foundry) — do not redistribute the
> binaries beyond the self-hosted web delivery the license permits.

## License

Aeonik is published by **CoType Foundry**.
Purchase a desktop + web license at <https://cotypefoundry.com/aeonik>.
The web license grants you `.woff2` delivery from your own origin.

## Files in use (variable fonts — active)

These are the binaries currently present and referenced by `aeonik.css`. Each
is a single variable file covering its whole weight range:

| File | Family | `wght` range | Usage |
|---|---|---|---|
| `Aeonik-VF.woff2` | Aeonik | 100–900 (normal) | Body copy, UI labels, buttons |
| `Aeonik-VF-italic.woff2` | Aeonik | 100–900 (italic) | Emphasis / italic body |
| `AeonikFono-VF.woff2` | Aeonik Fono | 400–700 | Display / h1–h6, hero metrics |
| `AeonikMono-VF.woff2` | Aeonik Mono | 400–500 | Code, eyebrows, metric labels |

Each `@font-face` uses a bundler-relative `src: url("./<file>.woff2")
format("woff2")` with a `font-weight` *range* (e.g. `100 900`). No
`tech(variations)` hint is needed — every target browser loads the variable
woff2 and the weight range advertises the supported axis.

### Per-weight alternative (legacy)

If you ever swap the VF builds for static per-weight files, the original set
was: `Aeonik-{Thin,Light,Regular,Medium,Bold,Black}.woff2` (100/300/400/500/
700/900), `AeonikFono-{Regular,Medium,Bold}.woff2` (400/500/700), and
`AeonikMono-{Regular,Medium}.woff2` (400/500). Restore one `@font-face` per
weight in `aeonik.css` and drop the `font-weight` ranges.

## Optional: next/font/local

The fonts are already self-hosted and active via the shared CSS — no further
step is required. As an optimisation you may migrate `apps/app/src/app/
layout.tsx` to `next/font/local` for automatic preloading and size-adjust
fallback metrics; this is per-app, so weigh it against the no-drift cost of
repeating the config across every Next.js app (`app`, `docs`, `web`).

### Committing the binaries

The `src: url("./*.woff2")` references are resolved and emitted by Next/
Turbopack **at build time** — so the `.woff2` files MUST be present on every
build (local, CI, and Vercel), not just on a dev machine. They are therefore
committed to this **private** repo (`oxagenai/oxagen-monorepo`), which is the
licensed-internal use a CoType web license permits — not public redistribution.

Do **not** mirror these binaries to a **public** repo, bucket, or CDN where the
raw font file becomes freely downloadable. If this repo is ever made public,
move the binaries to a private bucket and fetch them in the build step instead.

## CSS variables

The three typefaces are wired to these CSS custom properties (set in
`packages/ui/src/styles/globals.css`):

| Variable | Maps to | Applied to |
|---|---|---|
| `--font-sans` | `"Aeonik"` — body + UI | `<body>` default (+ `font-sans` utility) |
| `--font-display` | `"Aeonik Fono"` — headings | `h1`–`h6` base rule (+ `font-display` utility) |
| `--font-mono` | `"Aeonik Mono"` — mono | `code`/`kbd`/`samp`/`pre` base rule (+ `font-mono` utility) |
| `--font-wordmark` | `"Aeonik"` — the lowercase "oxagen" lockup | `.ox-wordmark` (weight 660, tracking -0.02em) |

The first three Tailwind `@theme` tokens also flow through as utility classes:
`font-sans`, `font-display`, `font-mono`.

## Unreferenced files

`SpaceGrotesk-VF.woff2` and `space-grotesk.css` sit in this directory but
nothing imports them — the wordmark was their only consumer and it is set in
Aeonik now. They are kept rather than deleted so the choice stays reversible:
removing a licensed binary is a separate decision from changing which face the
wordmark uses. If nothing adopts them, they can go.
