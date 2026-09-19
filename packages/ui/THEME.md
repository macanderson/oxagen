# Oxagen theme

**This file is not the source of truth, and nothing here restates a token
value.** It says where the truth lives, because a document that copies the
palette becomes a second authority the moment the palette moves, and that is
what this file used to be.

Until 2026-09-19 it described a skin called Stella: a warm paper light mode, a
cool dark canvas, and one gold at `#EFC53F` under the name `--ox-ember`. None of
that is what the app ships. It went stale when the frontends moved to the Oxagen
house kit, and it stayed stale long enough to contradict the code it claimed to
document, which is a worse outcome than having no document at all: the palette
was discoverable from the tokens, while this file actively prescribed values the
brand had retired.

## Where the truth lives

| Question | Read |
|---|---|
| What is every token worth? | `src/styles/house-tokens.css`, and `house-tokens.json` for the same values as data |
| What type scale and utilities exist? | `src/styles/house-tailwind.css` (the `text-m-*` marketing and `text-a-*` app scales) |
| Which font files load, and how? | `src/styles/house-fonts.css` and `src/styles/fonts/` |
| How do tokens map to semantic roles, per theme? | `src/styles/globals.css`, the `:root`, `.dark` and `prefers-color-scheme` blocks |
| What may a surface say, and which line may it use? | `.claude/skills/oxagen-branding/`, whose `references/positioning.md` carries the live and retired lines |
| Which component token does a shell surface take? | The table in `AGENTS.md` under "Design Token Usage in Shell Components" |

The first four are **generated**, not authored. `tools/scripts/sync-brand-assets.mjs`
vendors them from the house kit (`oxagenai/oxagen-brand`), and `pnpm check:brand`
fails when a vendored copy has drifted from the kit. Edit the kit, run the sync,
commit what it writes. Editing a vendored file by hand is reverted by the next
sync and caught by the check before that.

`globals.css` is the one file this package authors by hand, and it is the whole
reskin surface: it maps the kit's values onto the semantic roles components
consume. A component never names a kit token, a Tailwind palette color, or a
hex.

## The three rules a value cannot tell you

These are decisions rather than values, so they belong in prose and are stated
once, here.

**Gold is identity and action, never state.** At most one gold action per screen.
A gold border, dot or label that means "running", "passed" or "held" is a defect,
however good it looks. State has its own ramp, `--ox-st-*`.

**The kit ships two stops per state and both are marks.** The bare name is the
mark on ink and the `-ink` suffix is the mark on paper. A mark clears 3:1, which
is not enough for words, so a token that renders text needs a derived stop and
carries its measured ratio in a comment beside it. `--error-ink` and
`apps/web`'s `--fail-ink` are the two that exist. Nothing computes these ratios
yet, which is why the comment matters and why the gap has a ticket.

**Every theme block states every pair.** `globals.css` carries the dark theme
twice, under `.dark` and under `prefers-color-scheme`, and a value set in one and
not the other is a surface that changes colour depending on whether the reader
chose the theme or their operating system did. That has happened, so the file's
header says to keep them in sync and it means both directions.

## For the design-sync bundle

`.design-sync/config.json` reads this file as its guidelines document. It is
deliberately short: a generator handed a stale palette produces stale designs
with confidence, which is the failure this rewrite exists to end. The tokens
themselves reach the bundle as `_ds_bundle.css`, and they are what a designer or
a generator should read.
