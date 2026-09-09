# Space Grotesk — the house typeface

> **ACTIVE.** `space-grotesk.css` declares four static weights against the
> `.woff2` binaries beside it, and `packages/ui/src/styles/globals.css`
> `@import`s that file, so every app in this monorepo renders in it with no
> per-app font config. The `src` url()s are bundler-relative, so each app's
> Turbopack build emits the binaries from this one shared location.

Space Grotesk is not a preference — it is the face the
[Oxagen house brand system](https://github.com/macanderson/oxagen-house-brand)
is built out of. Both wordmarks are this font's own outlines at weight 600:
`oxagen` with its **x** in gold, `stella*` with its asterisk in gold. Nothing
in the marks is drawn, so a different UI face would put the running text and
the logo in two unrelated designs.

## Where these files come from

They are vendored, never hand-copied:

```sh
node tools/scripts/sync-brand-assets.mjs          # pull from the house kit
node tools/scripts/sync-brand-assets.mjs --check  # fail if they have drifted
```

The kit ships the Latin subset it measured the marks against. Do not replace
these with a CDN link, a Google Fonts `@import`, or a differently-subsetted
build: the metrics are what the wordmark geometry was checked against.

## Files in use

| File | Weight | Usage |
|---|---|---|
| `space-grotesk-latin-400.woff2` | 400 | Body copy |
| `space-grotesk-latin-500.woff2` | 500 | UI labels, buttons, table headers |
| `space-grotesk-latin-600.woff2` | 600 | Headings, and the wordmark |
| `space-grotesk-latin-700.woff2` | 700 | The `Ox` icon lettermark |

Four static weights rather than one variable face: the design asks for exactly
four stops, and four ~30 KB subsets beat a 120 KB variable binary when nothing
interpolates between them. There is no italic — the kit does not use one.

## There is no house mono, on purpose

The house rule is **"Space Grotesk is not a code face."** Terminal output,
code blocks and identifiers take the system monospace stack, which
`globals.css` binds to `--font-mono`. Do not add a Space Grotesk Mono (there
isn't one) and do not substitute a third-party mono — that would put a face in
the product the kit never approved, and it would drift the moment the kit is
rebuilt.

## License

SIL Open Font License 1.1 — see `LICENSE-OFL.txt` in this directory, which
must travel with the binaries. Space Grotesk is by Florian Karsten.
Self-hosting and redistribution are both permitted, so unlike the licensed
face this replaced (Aeonik, CoType Foundry — removed 2026-09-08 when the house
system landed) these binaries are safe in a public repo.

## CSS variables

Wired in `packages/ui/src/styles/globals.css`:

| Variable | Maps to | Applied to |
|---|---|---|
| `--font-sans` | `"Space Grotesk"` | `<body>` default (+ `font-sans` utility) |
| `--font-display` | `"Space Grotesk"` | `h1`–`h6` base rule (+ `font-display` utility) |
| `--font-mono` | system monospace stack | `code`/`kbd`/`samp`/`pre` (+ `font-mono` utility) |
| `--font-wordmark` | `"Space Grotesk"` | `.ox-wordmark` (weight 600, lowercase) |

`--font-display` intentionally resolves to the same family as `--font-sans`:
the house system is one face at several weights, and the token is kept so
headings can be retuned (weight, tracking) in one place.
