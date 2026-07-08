---
name: brand-voice-design
description: How to develop brand voice and visual design guidelines that an agent can actually apply — capture voice as concrete rules and examples, design as tokens and do/don't pairs, and write both so a model produces on-brand copy and UI without a human in the loop.
metadata:
  weight: high
  category: design
---

# Developing brand voice & design guidelines

Load this skill when you are creating or refining the guidelines that keep
copy and interfaces on-brand — especially when the consumer is an agent,
not just a person. A human designer can absorb a mood board and a vibe; a
model needs the rule made explicit. The measure of a good guideline is
simple: could an agent, reading only this, produce work a brand owner
would sign off on? Write to that bar.

## Turn voice into rules, not adjectives

"Confident, friendly, human" tells a model almost nothing — every brand
claims those. Convert each trait into a rule it can act on: sentence
length, person and tense, whether to use contractions, how much jargon,
how to handle humour, what reading level. "Write in second person, active
voice, short declarative sentences; never hype, never hedge" changes
output. A list of adjectives does not.

## Anchor every rule with a matched pair

Show the rule as a **before/after** or **on-brand/off-brand** pair drawn
from real copy. A model learns a voice far faster from "we don't say *X*,
we say *Y*" than from an abstract description. Pairs also resolve the edge
cases prose leaves ambiguous — the example decides what the sentence
could not.

## Give it words to use and words to avoid

Maintain a short lexicon: preferred terms, banned terms, and the reason.
Name the product features the way they should always be named, the words
that are off-brand or legally fraught, and the tone-killers to avoid.
This is the highest-leverage part of a voice guide for an agent, because
it is unambiguous — a word is either on the list or it is not.

## Express visual design as tokens, not screenshots

Capture the design system as named, reusable values — color roles,
type scale, spacing steps, radii, elevation — not as one-off pixel values
pulled from a mockup. Tokens are what let an agent apply the system to a
surface it has never seen and stay consistent. Give each token a role
("surface", "accent", "danger"), not just a hex, so the model knows *when*
to reach for it, and make sure the palette works in both light and dark.

## State the do's and don'ts of layout and motion

Beyond tokens, name the compositional rules: how much whitespace, when to
use which type size, how dense a layout should be, what corner and shadow
language to use, how motion should feel (and when to omit it for reduced
motion). Pair each with a don't. An agent laying out a screen needs the
same explicit guidance for space and rhythm that the voice section gives
for words.

## Make it accessible by construction

Fold accessibility into the guidelines, not into a separate afterthought:
minimum contrast for text and controls, focus states, target sizes,
motion that respects a reduced-motion preference, and alt-text
expectations for imagery. When the rule is in the guideline, on-brand and
accessible become the same output instead of competing ones.

## Write it so an agent can load and apply it

Structure the guideline the way a model reads best: one concern per
section, the rule first and the reason second, concrete examples over
description, and no dependence on an image the model cannot see. Keep it
generic to the brand, not to one page or campaign. Then test it: hand the
guideline to an agent, ask for a piece of copy and a small UI, and see
whether the result is on-brand. Where it drifts, the guideline was
ambiguous there — tighten that rule and its example, and try again.
