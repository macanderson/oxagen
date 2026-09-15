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
| Anything about access, credentials, connections, permissions, or tools | `references/positioning.md`, the section *The keys stay with you* |
| A page, ad, deck, or UI | `references/system.md` and `assets/tokens.css` |
| Copy for a specific surface (site, ad, email, docs, UI, launch) | `references/examples.md` |

## Where this skill lives

The source of truth is `skills/oxagen-branding/` in the house brand kit, `oxagenai/oxagen-brand`, beside the marks, tokens, ads, and content cards it describes. The oxagen repo vendors a copy at `.claude/skills/oxagen-branding/` through `tools/scripts/sync-brand-assets.mjs`, and `pnpm check:brand` fails on drift. Edit the kit, run the sync, commit both. Never edit the vendored copy alone.

## What Oxagen is, in one sentence

Oxagen is the platform that governs and operates the autonomous agents an enterprise runs. It is the organization's agent control plane, and the operator's agent fleet management. Every agent operates under a mandate: its access, its budget, its tools, its rules, set by the teams accountable for it and enforced on every run.

Every piece of copy is downstream of that sentence. It has two names on purpose. **Agent control plane** is what Oxagen is to the enterprise: where the terms are set and enforced. **Agent fleet management** is what an operator does with it all day: see every agent that is running, what each one has asked for, what it has spent, and what it did, then answer, fund, hold, or stop it. Use either name. Use both when there is room. Spend management is part of fleet management, not a separate product. A mandate has four clauses, and every claim belongs to one of them: access (security sets it), budget and rules (FinOps sets it), equipment (engineering sets it), and the record (the platform keeps it). If a line does not connect to a clause, cut the line. The definition of done is a mechanism inside the record clause, not the sentence.

## The six rules that never bend

1. **Gold is identity, plus at most one action per screen.** Gold never carries state and never fills a surface. State is carried by shape: double border for held, dashed for pending, single for broken.
2. **No em dashes in anything a customer reads.** Use a period, a comma, or a colon. This includes UI strings, docs, ads, and specs.
3. **Sentence case headings.** Always.
4. **Wordmarks are lowercase: oxagen, stella.** In prose they are names and take a capital: Oxagen, Stella.
5. **Mission Control vocabulary is the product's vocabulary.** Run, turn, step, frame, operator, agent, workspace, governed action, mandate, request, rule. Never session, trace, attempt, execution, or invocation in customer-facing prose. See `references/words.md`.
6. **The agent asks, the rule decides, the record keeps the answer.** Copy never describes an agent that holds a key, a token, or a standing grant. Access is requested at the moment of use and answered by a rule the owning team wrote: allowed, denied, or routed to a named person. Never write "connect your agent to X" or "give the agent access to X". See *The keys stay with you* in `references/positioning.md`.

## Positioning, the short version

Every other layer covers one clause of the mandate and stops. Identity says who the agent is. Gateways say which tools it can call. Billing says what it consumed. Prompt repos say what it was told. Oxagen binds all of it into one object and enforces it on every call, then keeps the record.

The category has two names and Oxagen owns both: **the agent control plane** and **agent fleet management**. Fleet management is the name that pulls hardest away from the plays around us. An observe play watches. A pure governance play says no. Fleet management runs the operation: it dispatches, answers, funds, holds, and stops, and it carries the spend. Do not say observability, governance, or evals as the category; those are owned, and none of them operates anything.

The lead line today is **Can you explain your AI bill? Neither can your provider.** For the security reader, the access line is **Don't hand your agents the keys.** The dod line, **The agent doesn't get to decide it's done.**, is held until the dod ships. The full table and the decision are in `references/positioning.md`.

## Voice, the short version

Oxagen sounds like a senior engineer who has read the logs and is telling you what happened. Plain, specific, unhurried, a little dry. It states facts, names numbers, and stops. It never sells fear, never says "AI-powered", and never claims more than the record shows.

Full guidance, with before and after pairs, is in `references/voice.md`.

## Prose rules that apply everywhere

- Actor first. "The rule denies the push" not "The push is denied by the rule."
- Concrete verbs. Ask, allow, deny, route, lock, block, settle, verify, hold, break. Not enable, empower, leverage, ensure.
- One idea per sentence. If a sentence has a semicolon, it is two sentences.
- Numbers over adjectives. "Blocked once, held on the second stop" beats "reliable."
- A feature pairs with what it does for the reader in the same sentence.
- Never strengthen a claim past the evidence. A held dod means done, not proven. Proven is the witness's word. An allowed request means a rule allowed it, not that the action was safe.
- Cut "very", "really", "seamless", "robust", "powerful", "revolutionary", and every word in `references/words.md` under avoid.
- Say Oxagen, not "we", in product copy. Say "you", never "users", when addressing the reader.

## Checklist before shipping any asset

- [ ] One gold action at most; gold nowhere else except the mark
- [ ] State shown by shape, not color
- [ ] No em dashes
- [ ] Headings in sentence case
- [ ] oxagen and stella lowercase as marks, capitalized in prose
- [ ] No forbidden vocabulary (`references/words.md`)
- [ ] First sentence connects to the positioning sentence and names a mandate clause
- [ ] No agent holds a key, a token, or standing access anywhere in the copy; it asks, a rule answers
- [ ] Every claim is one the record can back
- [ ] Space Grotesk for everything; system mono for data, digests, and commands
- [ ] 12px card radius, 1120px wrap, dark first with the parchment light theme intact
