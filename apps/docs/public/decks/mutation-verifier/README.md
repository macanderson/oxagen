# Mutation verifier ship-note deck

Self-contained HTML slide deck for **engineering and product**: the mutation
verifier shipped in `@oxagen/agent-engine` (ADR-029). Covers the false-green
failure class, the shadow-revert witness gate, opt-in mutation scoring, why it
matters to the accountability chain, the competitive read, and the V2 roadmap
(LLM-guided mutants, snapshot shadows, CI merge gates, evals feedback loop).

Served by `apps/docs` at the clean URL **`/decks/mutation-verifier`**
(rewrite in `apps/docs/next.config.mjs`). Statically hosted, no build step.

- **Files:** `index.html` (deck), `script-data.js` (private presenter script).
- **Branding:** shares the exact design system, embedded brand fonts, and deck
  engine as the other `decks/*` decks; the shell was spliced from
  `decks/architecture-deep-dive/index.html`. Only the
  `<section class="slide">` content differs.
- **Navigate:** arrow keys, dots, swipe. Deep-link a slide with `#<n>`.
- **Presenter:** press **S** for a private teleprompter window (stays off
  screenshare; syncs to the deck via `BroadcastChannel`).
- **⌘P / Ctrl+P** prints a PDF, one page per slide.

## Regenerating

Edit the `<section class="slide">` blocks in `index.html` and the matching
entry in `script-data.js` (one presenter note per slide, positional: inserting
a slide requires inserting a note at the same index).
