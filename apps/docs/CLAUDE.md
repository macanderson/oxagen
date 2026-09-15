# apps/docs

This is docs.oxagen.sh. Every page under `content/docs/` and every string on
the landing page is read by customers, so two skills apply to any change that
touches words:

- **`oxagen-branding`** (`.claude/skills/oxagen-branding/`) owns positioning
  and vocabulary. Use the product's words exactly as `references/words.md`
  defines them: run, turn, step, frame, operator, agent, workspace, governed
  action. Read `references/examples.md` for the docs introduction pattern.
- **`clear-prose`** (`.claude/skills/clear-prose/`) owns the sentences. Docs
  are second person, imperative, one step per sentence, working command first,
  the reason in one line after. No em dashes, no exclamation points, no
  marketing language.

Docs describe what ships. A feature the positioning names but the product does
not carry yet does not get a page until it lands.

Before you commit, run `pnpm check:prose`. CI runs it too.
