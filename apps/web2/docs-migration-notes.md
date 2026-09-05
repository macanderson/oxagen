# content/docs — how this tree was built

This is a one-time copy, not a live sync. Two source trees were merged here
so `/docs/*` in `apps/web2` is one Fumadocs collection instead of two
separate sites:

- `content/docs/platform/**` — copied from `apps/docs/content/docs/**`
  (the `@oxagen/docs` app in this monorepo, at the time of the copy).
  Internal links were rewritten from `/docs/...` to `/docs/platform/...`.
- `content/docs/stella/**` — copied from the `stella` repo's
  `website/content/docs/**` (`/Users/macanderson/Projects/stella` on the
  machine this was built on). That repo was read-only for this work: nothing
  under it was modified. Internal links were rewritten from `/docs/...` to
  `/docs/stella/...`.

Both source apps continue to exist and build independently (`apps/docs` in
this monorepo, and the standalone `stella/website`). This copy will drift
from them the moment either one changes. If `apps/web2` is the one that
ships, the next step is deciding which tree is authoritative and either
retiring the other source or wiring a real sync — neither is done here.

## What did not come across faithfully

Stella's docs lean on ~20 bespoke inline-SVG diagrams and an interactive
Command Deck explorer, built against Stella's own black-and-gold token
system (`design/tokens/stella-tokens.json` in that repo). Porting that whole
token system into this app would mean shipping two competing brand layers
side by side, so:

- The ~20 diagram components (`HeroFlowDiagram`, `EnginePathsDiagram`, …)
  render as a labelled text panel carrying the diagram's own one-sentence
  description (see `src/components/stella/diagram-placeholder.tsx`) instead
  of the original line art.
- Everything else — the card primitives (`CardGrid`/`SpecCard`/`ToolCard`/
  `OptionCard`/`Badge`), the provider grid and logo marks, the Command Deck
  screenshots (`DeckShot`, `public/tui/*.svg`), and the nine-pane Command
  Deck tab explorer (`CommandDeckExplorer`) — is ported structurally in
  `src/components/stella/*` and restyled against this app's own Fumadocs
  tokens (`--color-fd-*`) rather than Stella's `--stella-*` tokens.

The prose content itself — every `.mdx` file — is copied in full; nothing
was summarized or replaced with a placeholder.
