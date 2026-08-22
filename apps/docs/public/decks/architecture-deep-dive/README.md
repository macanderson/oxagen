# Architecture deep-dive deck

Self-contained HTML slide deck for the **office of the CIO** — the engineering
tour behind the Oxagen platform: capability contracts & surface parity,
envelope encryption at rest, vendor-neutral BYOK, SOC 2 tenant isolation, the
ClickHouse→Stripe metering loop, observability, plugins/skills, and graph
grounding.

Served by `apps/docs` at the clean URL **`/decks/architecture-deep-dive`**
(rewrite in `apps/docs/next.config.mjs`). Statically hosted — no build step.

- **Files:** `index.html` (deck), `script-data.js` (private presenter script).
- **Branding:** shares the exact design system, embedded brand fonts, and deck
  engine as `decks/first-call-enterprise` — the `<style>` block, hexfield
  background, navbar, and navigation JS are reused verbatim so the two decks
  stay pixel-consistent. Only the `<section class="slide">` content differs.
- **Navigate:** arrow keys, dots, swipe. Deep-link a slide with `#<n>`.
- **Presenter:** press **S** for a private teleprompter window (stays off
  screenshare; syncs to the deck via `BroadcastChannel`).
- **⌘P / Ctrl+P** prints a PDF — one A4-landscape page per slide, ink-friendly.

## Regenerating

Edit the `<section class="slide">` blocks in `index.html` and the matching
entry in `script-data.js` (one presenter note per slide, in order). The shared
branding shell (head + `<style>` + fonts + engine) is copied from
`decks/first-call-enterprise/index.html`; keep it in sync if the brand system
changes there.

> The deck cites internal architecture (crypto, RLS, metering). Review before
> attaching this project to a public domain.
