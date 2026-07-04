# @oxagen/web-v2 — oxagen.sh website (v2)

Static site deployed as the Vercel project **oxagen-v2-web**. No build step —
Vercel serves this directory as-is (framework preset: Other, root directory
`apps/web`).

## Current homepage

`index.html` is the July 2026 **platform health & investor deck** — a fully
self-contained page (brand fonts embedded as data URIs, zero external
requests). Interim content until the real v2 site lands.

- Navigate: arrow keys, dots, swipe. Deep-link a slide with `#<n>`.
- **⌘P / Ctrl+P** produces a print-ready PDF: one A4-landscape page per slide,
  light ink-friendly palette, all charts rendered at final state.

## Regenerating the deck

The deck is generated from a source file kept outside the repo (Claude session
artifact — see `verifications/` and the `platform-health-audit-2026-07`
project memory for provenance). To update it, edit the source, re-embed the
fonts from `packages/ui/src/styles/fonts/*.woff2` as base64 data URIs, wrap in
`<!doctype html><html lang="en">…</html>`, and replace `index.html`.

> Note: the deck cites internal audit findings. Anything security-sensitive
> should be reviewed before this project is attached to a public domain.
