# The house spinner

Two files, both synced from the Oxagen house brand kit by
`node tools/scripts/sync-brand-assets.mjs` — do not edit them here.

| File | What it is | Use it for |
|---|---|---|
| `oxagen-spinner.svg` | The `Ox` mark with the metal sweeping across it | Any waiting state: the PWA splash, route transitions, a full-page load |
| `oxagen-spinner-wordmark.svg` | The same sweep across the whole `oxagen` wordmark | A wide slot where the word already belongs — a splash screen, a boot log |

## Why there is no dark and light variant

Each file carries its own `<style>` block with two rules:

- `:root { color: … }` plus a `prefers-color-scheme: dark` override, so the
  mark takes the ink or the paper depending on the tab it lands in.
- a `prefers-reduced-motion: reduce` rule that stops the sweep and shows the
  mark at full opacity instead of a dimmed base.

Both work inside `<img src>`, so one `<img>` is the whole integration. The GIF
pair this replaced (`oxagen-spinner-assemble-{dark,light}.gif`) existed only to
switch themes by hand and was retired with the house system.

```tsx
<img src="/spinner/oxagen-spinner.svg" alt="" width={64} height={64} aria-hidden />
```

Keep a non-image fallback for the case where the asset 404s — see
`src/components/pwa/pwa-splash.tsx`, which swaps in a pure-CSS ring `onError`.

## Do not

- Recolour the sweep. The metal is the kit's, and the mark under it is one
  colour by design.
- Re-time the animation. The 3.2s period is the kit's `--ox-shimmer-period`
  rhythm; a faster spinner reads as a different brand.
- Inline the file and drop its `<style>` block — that is where both the theme
  and the accessibility behaviour live.
