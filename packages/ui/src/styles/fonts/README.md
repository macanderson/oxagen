# House typefaces

The [Oxagen house brand system](https://github.com/macanderson/oxagen-house-brand)
sets type in three faces, each with one job:

| Face | Token | Sets |
|---|---|---|
| Space Grotesk | `--ox-font-display` | The wordmarks, and h1 to h3 |
| Geist | `--ox-font` | h4 to h6, body text, labels, buttons, tables, navigation |
| Monaspace Neon | `--ox-font-mono` | Code, terminal output, logs, digests, paths, and ids |

Both wordmarks are Space Grotesk's own outlines at weight 600. Nothing in the
marks is drawn, so the wordmark has to render in Space Grotesk or it stops
matching the logo.

## Stylesheets

`../house-fonts.css` holds the `@font-face` rules for all three faces, with
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
| `monaspace-neon-latin-wght.woff2` | Monaspace Neon, variable weight 200 to 800 |

## Licenses

All three faces are under the SIL Open Font License 1.1, which permits
self-hosting and redistribution. Each license file must travel with its
binaries: `LICENSE-OFL.txt` (Space Grotesk, by Florian Karsten),
`LICENSE-OFL-geist.txt`, and `LICENSE-OFL-monaspace.txt`.
