# Oxagen ui/src/styles — Space Grotesk addition

## What changed
Two precise edits to `globals.css`, plus two new files in `fonts/`. **No color
tokens were changed** — your uploaded `globals.css` was already a complete, correct
"Nocturne Violet" implementation; every value matched the delivered `tokens.css`
(violet ramp, ember mark, surfaces, ink, borders, semantics). Re-inferring them
would have produced the same file. The real gap was the typeface.

### 1. New font: Space Grotesk (the logomark wordmark face)
- `fonts/SpaceGrotesk-VF.woff2` — variable font, weight axis **300–700**, self-hosted
  (converted from the supplied TTF; matches your Aeonik VF approach). 48 KB.
- `fonts/space-grotesk.css` — the `@font-face` declaration.
- Licensed SIL Open Font License 1.1 (Google Fonts). Free to self-host/redistribute.

### 2. globals.css edits (only these two)
- Added `@import "./fonts/space-grotesk.css";` right after the Aeonik import.
- Set Space Grotesk as `--font-display` (the `.ox-wordmark` face), ahead of the
  Aeonik Fono fallback. **Why:** Space Grotesk is the typeface in the OXAGEN
  logomark, so the wordmark in-app now matches the logo. `--font-sans` (Aeonik)
  and `--font-mono` (Aeonik Mono) are unchanged.

## IMPORTANT — merge, don't overwrite the fonts/ dir
Your `globals.css` still imports `./fonts/aeonik.css` and the Aeonik woff2 files
(`Aeonik-VF.woff2`, `AeonikFono-VF.woff2`, `AeonikMono-VF.woff2`, `aeonik.css`).
Those were not part of this upload, so they are NOT in this zip. **Copy the two
Space Grotesk files into your existing `fonts/` directory** — do not replace the
folder, or you'll drop Aeonik.

Final `ui/src/styles/` should be:
```
styles/
  globals.css              ← replace with the one in this zip
  fonts/
    aeonik.css             ← keep (yours)
    Aeonik-VF.woff2        ← keep (yours)
    AeonikFono-VF.woff2    ← keep (yours)
    AeonikMono-VF.woff2    ← keep (yours)
    space-grotesk.css      ← add (this zip)
    SpaceGrotesk-VF.woff2  ← add (this zip)
```

## Using it
- The wordmark already picks it up via `.ox-wordmark` (uses `--font-display`).
- For display headings, apply `font-display` (the Tailwind utility from the
  `--font-display` token) or `var(--font-display)`.
- Weights 300–700 are all available from the single VF; e.g. `font-weight: 500`.

## If you'd rather pull from Google Fonts instead of self-hosting
Space Grotesk is at https://fonts.google.com/specimen/Space+Grotesk. You could
swap the `@font-face` for a `@import url('https://fonts.googleapis.com/...')`,
but self-hosting (as done here) avoids the extra network round-trip and a FOUT,
and matches how Aeonik is already handled. Recommend keeping it self-hosted.
