---
name: oxagen-branding
description: The authority for anything that carries Oxagen or Stella branding or speaks in Oxagen's voice. Use it whenever you create or edit a page, post, ad, email, deck, doc, spec, UI string, error message, CLI output, README, or any prose a person will read on behalf of either brand, even if the request does not say "brand" or "voice". Covers the marks, tokens, type, layout rules, positioning, one-liners, voice and tone, words to use, words to avoid, and worked examples. Oxagen and Stella share one house system; the logo is the only difference.
---

# Oxagen branding

Read this whole file first. Then read the reference for what you are making:

| Making | Read next |
|---|---|
| Anything with words in it | `references/voice.md`, then `references/words.md` |
| A headline, hero, ad, tagline, or the first sentence of anything | `references/positioning.md` |
| A page, ad, deck, or UI | `references/system.md` and `assets/tokens.css` |
| Copy for a specific surface (site, ad, email, docs, UI, launch) | `references/examples.md` |

## What Oxagen is, in one sentence

Oxagen is the control plane for agent work: it locks a definition of done into every run before the agent's first tool call, blocks the run from ending until that definition holds, and settles the result into a signed record anyone can verify offline.

Every piece of copy is downstream of that sentence. If a line does not connect to it, cut the line.

## The five rules that never bend

1. **Gold is identity, plus at most one action per screen.** Gold never carries state and never fills a surface. State is carried by shape: double border for held, dashed for pending, single for broken.
2. **No em dashes in anything a customer reads.** Use a period, a comma, or a colon. This includes UI strings, docs, ads, and specs.
3. **Sentence case headings.** Always.
4. **Wordmarks are lowercase: oxagen, stella.** In prose they are names and take a capital: Oxagen, Stella.
5. **Mission Control vocabulary is the product's vocabulary.** Run, turn, step, frame, operator, agent, workspace, governed action. Never session, trace, attempt, execution, or invocation in customer-facing prose. See `references/words.md`.

## Positioning, the short version

Every other tool watches the agent and reports. Oxagen decides when the agent is done and can prove it to someone who does not trust you.

The category is **the control plane for agent work**. Do not say observability, governance, or evals; those are owned, and all three mean watch and report.

The lead line is **The agent doesn't get to decide it's done.** Other approved lines and when to use each are in `references/positioning.md`.

## Voice, the short version

Oxagen sounds like a senior engineer who has read the logs and is telling you what happened. Plain, specific, unhurried, a little dry. It states facts, names numbers, and stops. It never sells fear, never says "AI-powered", and never claims more than the record shows.

Full guidance, with before and after pairs, is in `references/voice.md`.

## Prose rules that apply everywhere

- Actor first. "The wrapper locks the dod" not "The dod is locked by the wrapper."
- Concrete verbs. Lock, block, settle, verify, hold, break. Not enable, empower, leverage, ensure.
- One idea per sentence. If a sentence has a semicolon, it is two sentences.
- Numbers over adjectives. "Blocked once, held on the second stop" beats "reliable."
- A feature pairs with what it does for the reader in the same sentence.
- Never strengthen a claim past the evidence. A held dod means done, not proven. Proven is the witness's word.
- Cut "very", "really", "seamless", "robust", "powerful", "revolutionary", and every word in `references/words.md` under avoid.
- Say Oxagen, not "we", in product copy. Say "you", never "users", when addressing the reader.

## Checklist before shipping any asset

- [ ] One gold action at most; gold nowhere else except the mark
- [ ] State shown by shape, not color
- [ ] No em dashes
- [ ] Headings in sentence case
- [ ] oxagen and stella lowercase as marks, capitalized in prose
- [ ] No forbidden vocabulary (`references/words.md`)
- [ ] First sentence connects to the positioning sentence
- [ ] Every claim is one the record can back
- [ ] Space Grotesk for everything; system mono for data, digests, and commands
- [ ] 12px card radius, 1120px wrap, dark first with the parchment light theme intact
