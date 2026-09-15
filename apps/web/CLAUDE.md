# apps/web

This is oxagen.sh. Everything in it is read by customers, so two skills apply
to every change that touches words or visuals:

- **`oxagen-branding`** (`.claude/skills/oxagen-branding/`) owns positioning,
  the approved lines, vocabulary, and the visual system. Read its `SKILL.md`
  first, then `references/positioning.md` before any headline, hero, or
  opening sentence, and `references/examples.md` for the website hero and
  product page patterns.
- **`clear-prose`** (`.claude/skills/clear-prose/`) owns the sentences: no em
  dashes, no exclamation points, active voice, sentence case, "you" not
  "users," claims the record can back.

Before you commit, run `pnpm check:prose`. CI runs it too, and it fails on
any em dash, exclamation point, or avoid-list word in the site's copy.

Do not write new taglines. If a surface needs a line, pick one from
`references/positioning.md`. Never name a competitor. Never put a benchmark
number in public copy.

The build and layout notes are in `README.md`.
