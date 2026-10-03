# House typefaces

The [Oxagen house brand system](https://github.com/oxageninc/brand)
sets type in three faces, each with one job, and loads two more:

| Face | Token | Sets |
|---|---|---|
| Space Grotesk | `--ox-font-display` | The Oxagen and stella wordmarks, and on oxagen.sh every h1, h2, h3, and hero line |
| Geist | `--ox-font` | Every heading in the app, h4 to h6 on the docs and oxagen.sh, body text, labels, buttons, tables, navigation |
| Monaspace Neon | `--ox-font-mono` | Code, terminal output, logs, digests, paths, and ids |
| Aeonik, Aeonik Mono, Aeonik Fono | none | Loaded for a page that names them; no role uses them |

Both wordmarks are Space Grotesk's own outlines at weight 600. Nothing in the
marks is drawn, so the wordmark has to render in Space Grotesk or it stops
matching the logo.

In the app and the docs, Space Grotesk sets the wordmarks and nothing else.
The kit's `house-tailwind.css` points `--font-sans` and `--font-heading` at
Geist and exposes Space Grotesk to the marks as `--font-wordmark`. Mac set
Aeonik as the house sans on 2026-10-02 (oxageninc/brand#80) and set Geist
back on 2026-10-03. The Aeonik files stay here and load, and no role uses
them.

## Stylesheets

`../house-fonts.css` holds the `@font-face` rules for every face, with
`src` urls relative to this directory. Two stylesheets import it:

- `../globals.css`, which every Next.js app imports.
- `apps/desktop/src/styles.css`, which imports `@oxagen/ui/styles/house-fonts.css`
  beside `house-tokens.css`, because the desktop app does not use Tailwind.

Each bundler emits the binaries from this one shared directory.
`space-grotesk.css` declares only the four Space Grotesk weights. No app
imports it now. It stays exported for a page that needs the display face
alone.

## Source

They are vendored from the kit, never hand-copied:

```sh
node tools/scripts/sync-brand-assets.mjs          # pull from the house kit
node tools/scripts/sync-brand-assets.mjs --check  # fail if they have drifted
```

The kit ships the Latin subsets it measured the marks against. Do not replace
them with a CDN link, a Google Fonts `@import`, or a build subset another way.

## Files

| File | Face |
|---|---|
| `space-grotesk-latin-400.woff2` to `-700.woff2` | Space Grotesk, four static weights |
| `geist-latin-wght.woff2` | Geist, variable weight 100 to 900 |
| `aeonik-wght.woff2` | Aeonik, variable weight 100 to 900 |
| `aeonik-italic-wght.woff2` | Aeonik italic, variable weight 100 to 900 |
| `aeonik-mono-wght.woff2` | Aeonik Mono, variable weight 100 to 900 |
| `aeonik-fono-wght.woff2` | Aeonik Fono, variable weight 100 to 900 |
| `monaspace-neon-latin-wght.woff2` | Monaspace Neon, variable weight 200 to 800 |

## Licenses

Geist, Space Grotesk, and Monaspace Neon are under the SIL Open Font License
1.1. Each license file travels with its binaries: `LICENSE-OFL-geist.txt`,
`LICENSE-OFL.txt` (Space Grotesk, by Florian Karsten), and
`LICENSE-OFL-monaspace.txt`. Aeonik, Aeonik
Mono, and Aeonik Fono are by CoType Foundry.
