# Voice and tone

## The voice, in one line

A senior engineer who has read the logs and is telling you what happened.

## Five traits

**Plain.** Short words, short sentences, no jargon that a second-year engineer would have to look up. When a technical word is the right word (frame, seal, digest), use it and do not apologize.

**Specific.** Numbers, names, and file paths where a competitor would put an adjective. "Blocked once, held on the second stop" instead of "reliable enforcement."

**Unhurried.** No exclamation points. No urgency. Nothing is "finally here." The product does not need the reader to feel anything to understand it.

**Dry.** Understatement over emphasis. If a sentence would be stronger with the intensifier removed, remove it. Humor is allowed only as understatement and never as a joke.

**Honest to the record.** Say exactly what the evidence supports and stop. A held dod is done, not proven. An observe-tier run is recorded, not enforced. The UI never shows a stronger word than the frame allows, and neither does the copy.

## Tone by surface

| Surface | Tone shift | Example |
|---|---|---|
| Website hero | Most compressed. One claim, one sentence of how, one action. | The agent doesn't get to decide it's done. Oxagen locks a definition of done before the first tool call and blocks the run until it holds. Wrap Claude Code in sixty seconds. |
| Product page | Explains the mechanism in order. Reads like a good README. | see `examples.md` |
| Docs | Second person, imperative, one step per sentence. | Add two hooks to your Claude Code settings. Run a prompt. The lock appears before the first tool call. |
| UI strings | Terse, present tense, never a full sentence where a fragment reads faster. | Stop blocked. Broken: unit, scope. Denied by rule `no-push-main`. |
| Access requests | The request first, then the answer, then who gave it. Never the credential. | Push to `release/2026.09` requested by stella for Dana's task. Waiting on Priya, rule `release-branch`. |
| Errors | Say what happened and what to do, in that order. Never apologize. | The dod on disk does not match the lock. Restore `$OXAGEN_RUN_DIR/dod.toml` or start a new run. |
| Sales email | Two short paragraphs. The first names their situation. The second names one thing Oxagen would show them. | see `examples.md` |
| Launch post | Same as the product page, plus one paragraph on why now. No "we're thrilled." | see `examples.md` |
| Investor | Facts in sequence, with the numbers. Never adjectives about the team. | see `examples.md` |

## Before and after

Each pair shows the same idea in the wrong voice and then in Oxagen's.

**Enthusiasm**
Before: We're excited to introduce a revolutionary new way to ensure your AI agents deliver!
After: The agent doesn't get to decide it's done.

**Abstraction**
Before: Oxagen provides comprehensive governance and observability for autonomous agents across your organization.
After: Oxagen locks a definition of done into every run and blocks the run from ending until it holds.

**Overclaiming**
Before: Every run is verified and proven correct.
After: Every run ends held, pending, or broken. A held run is done. Proven is the witness's word, and it applies only when a witness flipped.

**Fear**
Before: Unchecked agents are a liability waiting to happen. Protect your organization today.
After: You find out whether the agent was done by reading the PR. Oxagen tells you before the run ends.

**Passive voice**
Before: The definition of done is locked before tool execution begins.
After: The wrapper locks the dod before the agent's first tool call.

**Adjective instead of number**
Before: Fast, seamless setup.
After: Two hooks. Sixty seconds. The first screen shows your own numbers.

**Jargon for its own sake**
Before: Cryptographically attested, tamper-evident evidence chains with Merkle-rooted seals.
After: Every frame is hash-chained to the one before it, and the seal signs the whole run. Anyone with the export can recompute the verdict.

**Marketing "we"**
Before: We believe agents should be accountable.
After: A run cannot end until its dod holds.

**Handing over the keys**
Before: Connect your agent to GitHub, Slack, and your database in one click.
After: The agent asks for GitHub when the task needs it. A rule you wrote answers, or a person you named does. The key stays in Oxagen.

**Automation as the sell**
Before: Requests are auto-approved so your agents never wait.
After: Reads of the public repo are allowed by rule. A push to main is denied by rule. A push to a release branch waits on the release owner.

**Vault talk**
Before: Enterprise-grade secret management keeps your credentials safe.
After: The agent never sees the key. There is nothing for it to leak.

## Punctuation and typography

- Periods and commas do the work. Colons for lists and definitions. No em dashes, no en dashes as separators, no semicolons in customer-facing copy.
- No exclamation points.
- Sentence case for headings, buttons, labels, and table headers.
- Code, commands, paths, digests, frame kinds, and verdict words in monospace: `dod.settled`, `held`, `oxagen dod verify`.
- Numbers as numerals when they are data (2 hooks, 60 seconds, 7 reasons) and as words when they open a sentence.
- Oxford comma.

## Names and casing

- oxagen, stella: lowercase as wordmarks and in logos.
- Oxagen, Stella: capitalized as names in prose.
- dod: lowercase, always, as a noun. "The dod held." Never DoD, never Dod, never "the DOD file."
- Mission Control: capitalized, no hyphen.
- Claude Code, Codex CLI: as their owners write them.
- held, pending, broken: lowercase, in monospace when used as verdict values, in plain text when used as words.
