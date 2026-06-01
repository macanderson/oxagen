# Aeonik Font Assets

> **LICENSED ASSETS REQUIRED — binaries are NOT in this repository.**
> The build and runtime are fully functional without them (system fonts fill in).
> The @font-face declarations in `aeonik.css` are inert until the files below
> are present.

## License

Aeonik is published by **CoType Foundry**.
Purchase a desktop + web license at <https://cotypefoundry.com/aeonik>.
The web license grants you `.woff2` delivery from your own origin.

## Files to drop here

Place all files in `packages/ui/src/styles/fonts/` (this directory):

| File | Family | Weight | Usage |
|---|---|---|---|
| `Aeonik-Thin.woff2` | Aeonik | 100 | Ultra-light decorative |
| `Aeonik-Light.woff2` | Aeonik | 300 | Light body copy |
| `Aeonik-Regular.woff2` | Aeonik | 400 | Body copy, UI labels |
| `Aeonik-Medium.woff2` | Aeonik | 500 | Subheadings, buttons |
| `Aeonik-Bold.woff2` | Aeonik | 700 | Strong emphasis |
| `Aeonik-Black.woff2` | Aeonik | 900 | Hero metrics |
| `AeonikFono-Regular.woff2` | Aeonik Fono | 400 | Display / h1–h6 |
| `AeonikFono-Medium.woff2` | Aeonik Fono | 500 | Display headings |
| `AeonikFono-Bold.woff2` | Aeonik Fono | 700 | Large display headings |
| `AeonikMono-Regular.woff2` | Aeonik Mono | 400 | Code, eyebrows, metrics |
| `AeonikMono-Medium.woff2` | Aeonik Mono | 500 | Prominent code/labels |

### Variable font alternative

If CoType provides variable-font builds, you can replace the per-weight
files with:

| File | Axis range |
|---|---|
| `Aeonik-VF.woff2` | `wght` 100–900 |
| `AeonikFono-VF.woff2` | `wght` 400–700 |
| `AeonikMono-VF.woff2` | `wght` 400–500 |

Update `aeonik.css` to use `format("woff2 supports variations")` and a
`font-weight` range (e.g. `100 900`) in each @font-face rule.

## Activating next/font/local (post-binary step)

Once the `.woff2` files are in place, migrate `apps/app/src/app/layout.tsx`
from the manual CSS `@import "./fonts/aeonik.css"` approach to
`next/font/local` for automatic preloading, font-display management, and
zero-FOUT delivery. The full migration code is documented in `aeonik.css`
at the top of the file.

Do **not** commit `.woff2` files to git — add a `.gitignore` entry and
distribute them via a private object-store bucket or the foundry's CDN
with a signed token if the license permits.

## CSS variables

The three typefaces are wired to these CSS custom properties (set in
`packages/ui/src/styles/globals.css`):

| Variable | Maps to |
|---|---|
| `--font-sans` | `"Aeonik"` — body + UI |
| `--font-display` | `"Aeonik Fono"` — all h1–h6 |
| `--font-mono` | `"Aeonik Mono"` — code, eyebrows |

These Tailwind `@theme` tokens flow through as utility classes:
`font-sans`, `font-display`, `font-mono`.
