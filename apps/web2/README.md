# apps/web2 — one site for Oxagen and Stella

Marketing pages, product pages with Stella as one product among them, and a
single documentation tree holding both the platform's docs and Stella's.

**Nothing is switched over.** `apps/web` (oxagen.sh) and `apps/docs`
(docs.oxagen.sh) both still exist and still serve; no domain, deployment, or
pipeline points at this app. The name `web2` is provisional.

```bash
pnpm --filter @oxagen/web2 dev        # localhost:3500
pnpm --filter @oxagen/web2 build      # 175 static pages
pnpm --filter @oxagen/web2 typecheck
pnpm --filter @oxagen/web2 lint
```

## Before taking this live: reverse the Stella redirects in `apps/docs`

`apps/docs/next.config.mjs` carries three **permanent** redirects sending
Stella's documentation paths away to a separate site, under a comment reading
"Stella's documentation moved to its own site":

| Source | Destination |
|---|---|
| `/stella` | `https://stella.oxagen.sh` |
| `/docs/stella` | `https://stella.oxagen.sh/docs` |
| `/docs/stella/:path*` | `https://stella.oxagen.sh/docs` (deep links collapse to the root) |

This app does the opposite: `/docs/stella/**` is served here, merged into one
Fumadocs collection with the platform docs. That was the brief (#2654), and it
reverses a decision that is still written into `apps/docs` today — so anyone
reading that config would reasonably conclude the split was settled.

Nothing breaks meanwhile, because `web2` serves nothing. But whoever takes this
app live has to decide what happens to those three redirects, and to the
`stella.oxagen.sh` site they point at. A 301 is cached by browsers and
intermediaries, so removing the redirects does not immediately un-redirect a
visitor who already followed one.

## What is written down elsewhere

- [`docs-migration-notes.md`](./docs-migration-notes.md) — how the two docs
  trees were merged, that it is a one-time copy rather than a live sync, and
  the ~20 Stella diagram components that render as a labelled text panel
  instead of their original line art.
- [`src/content/marketing/README.md`](./src/content/marketing/README.md) — how
  the marketing pages were extracted from `apps/web`, the link rewrites
  applied, and two known gaps: `/read` 404s, and the lead-capture forms
  validate client-side but post to endpoints this app does not implement.
