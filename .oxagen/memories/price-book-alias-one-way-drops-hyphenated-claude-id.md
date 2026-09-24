---
name: price-book-alias-one-way-drops-hyphenated-claude-id
type: bug
domain: billing
severity: P1
linear: none (GitHub #4024)
date: 2026-09-23
---

**Symptom:** Six wrapped-run cost rollups read null, and the rest read `estimated`. Every frame came from Claude Code on Opus 5.5.
**Root cause:** Claude Code sends `claude-opus-5-5`. OpenRouter publishes `anthropic/claude-opus-5.5`. `aliasesFor` in `packages/billing/src/price-sources.ts` derived the dotted spelling from a hyphenated id, but not the reverse. The OpenRouter row claimed its names first, `mergePublishedPrices` dropped the models.dev `claude-opus-5-5` row as a duplicate, and no row priced the id the harness sends.
**Fix:** `hyphenatedRelease` makes `aliasesFor` add the hyphenated form of a dotted release tail, with the same limits as `dottedRelease`.
**Guard:** `price-sources.test.ts`, "a dotted catalog id prices its hyphenated spelling". It merges the card, OpenRouter and models.dev rows and checks all six classes for `claude-opus-5-5`.
**Watch-outs:** Matching has no prefix inheritance, and a source ranked higher can claim a name and silently drop a lower row. When a new model reads unpriced, check which spelling the harness sends and which source claimed it first. Rollups already written keep their old cost until a reprice runs.
