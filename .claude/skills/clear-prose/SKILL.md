---
name: clear-prose
description: Writing rules for anything a person will read from Oxagen or Stella, whatever the surface. Use whenever you write or edit a page, doc, post, email, README, changelog, UI string, error message, CLI output, or commit message, even if the request does not mention prose or style. Pairs with oxagen-branding, which owns positioning, vocabulary, and the visual system; this skill owns the sentences.
---

# Clear prose

The voice is a senior engineer who has read the logs and is telling you what
happened. Plain, specific, unhurried, a little dry. State the fact, name the
number, stop.

## Rules that never bend

1. **No em dashes, no en dashes as separators, no double hyphens standing in
   for one.** Use a period, a comma, a colon, or parentheses.
2. **No exclamation points.**
3. **Active voice, actor first.** "The wrapper locks the dod," not "the dod is
   locked by the wrapper."
4. **One idea per sentence.** A semicolon means two sentences.
5. **Sentence case** for headings, buttons, labels, and table headers.
6. **Oxford comma.**
7. **Say "you," never "users."** Say Oxagen or Stella, not "we," in product
   copy.
8. **Numbers over adjectives.** "Two hooks, sixty seconds" beats "fast setup."
   Numerals when the number is data, words when it opens a sentence.
9. **Every claim is one the record can back.** Never strengthen a claim past
   the evidence. A held dod is done. Proven is the witness's word.
10. **Open on the reader's situation**, not on what the product is.

## Cut these on sight

- Filler openers: "In today's world," "As AI agents become," "With the rise
  of," "It's no secret that," "We believe," "We're on a mission."
- Words that mean nothing: seamless, robust, powerful, revolutionary,
  cutting-edge, next-generation, game-changing, best-in-class, world-class,
  enterprise-grade, comprehensive, holistic, end-to-end, turnkey, frictionless,
  effortless, magic.
- Intensifiers: very, really, truly, genuinely, incredibly, extremely, deeply,
  highly, super.
- Emotional and fear sells: excited, thrilled, delighted, passionate, finally,
  imagine, rogue, unchecked, safeguard, liability.
- Consultant verbs: leverage, utilize, enable you to, in order to.
- Category words owned by others: observability, evals, guardrails, trust
  layer, safety layer.
- Overclaims: guaranteed, always and never about outcomes, 100 percent,
  eliminates, AI-powered.

The full use and avoid lists, with replacements, are in
`.claude/skills/oxagen-branding/references/words.md`.

## Shape of a piece

1. The reader's situation, in their words.
2. What happens instead, in one line.
3. How it works, in order, with the mechanism named.
4. The proof: a number, a record, a command that runs.
5. One next step.

## Docs, specifically

Second person, imperative, one step per sentence. Working command first, the
reason in one line after. Code, commands, paths, ids, and verdict words in
monospace. No marketing language in a doc.

## UI strings and errors

Terse, present tense, a fragment where a fragment reads faster. An error says
what happened, then what to do, in that order. Never apologize.

## Before shipping

Run `pnpm check:prose`. It scans the website and the docs for em dashes,
exclamation points, and the avoid list, and fails on any hit. Then read the
piece once and ask: does the first sentence name the reader's situation, can
every claim be shown, is there a word that could go?
