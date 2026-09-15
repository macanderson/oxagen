# Positioning

Read this before writing any headline, hero, tagline, ad, or opening sentence.

## The claim

Every other tool in the category watches the agent and reports. Oxagen decides when the agent is done, and can prove it to someone who does not trust you.

## The category

**The control plane for agent work.**

Not observability. Not governance. Not evals. Not guardrails. Not a trust layer. Each of those is owned by someone, and each one means "watch and report." Oxagen acts: it blocks a run from ending. Name the category by what it does, and let the definition of done carry the difference.

## The lead line and when to use each line

**Decision, 2026-09-15 (Mac):** the dod does not ship yet, so the dod lines are
held until it does. Until then the lead is the bill. The three lines below the
rule come from the shipped house ads in `oxagenai/oxagen-brand` and are the only
lead lines for the site, ads, and outreach today. When the dod lands, the dod
lines move back to the top of this table; nothing else changes.

| Line | Use it for | Why it works |
|---|---|---|
| **Can you explain your AI bill? Neither can your provider.** | The top of the site, cold email subject lines, the bill ad | Names the pain the buyer feels this month, and the product proves it today: every call priced by token class, attributed to the person, agent, run, turn, and step. |
| **Stop wasting money on AI.** | The Oxagen product page, the waste ad | Fewer tokens, same answers. The claim the record can back now. |
| **Never re-explain yourself to AI ever again.** | The memory ad, the knowledge graph section | Taught once, known by every agent you run. |

Held until the dod ships:

| Line | Use it for | Why it works |
|---|---|---|
| **The agent doesn't get to decide it's done.** | Rooms, decks, the top of the site, cold email subject lines | Names the failure every engineering lead has lived. The reader finishes the thought. |
| **Define done before the agent starts. Prove it after.** | Product pages, docs intros, anything explaining both halves | Both halves in one sentence: the visible dod and the hidden witness. |
| **Runs that end with a verdict, not a claim.** | Finance, procurement, the CFO slide | Says the meter follows the outcome without saying the word pricing. |
| **Prove it to someone who doesn't trust you.** | The verify feature, audit and insurance conversations | Names the outside dependency, which is the moat. |
| **Steer. Govern. Observe.** | Footer, favicon-sized places, the existing three pillars | Retained from the current system. Never the lead; the lead is the dod. |

Do not write new taglines. If a surface needs a line, pick one above, from the live rows.

## The pitch, three sentences

Your agents currently tell you when they are finished, and you find out later whether they were right. Oxagen locks a definition of done into every run before the first tool call, blocks the run from ending until it holds, and settles the result into a signed record your auditor can recompute offline. You see what every run cost, what it produced, and which runs did the job, and you pay only for the runs that are proven.

## The pitch, one sentence

Oxagen locks a definition of done into every agent run before it starts, blocks the run from ending until it holds, and proves the result to anyone with the export.

## Proof points, stated so they survive a rebuttal

- **Pre-committed, not post-hoc.** The dod is locked before the agent moves, and its position in the run's chain proves it. Evaluation tools score afterward, with a model that has the same blind spots as the model that did the work.
- **Two halves, on purpose.** The dod is fully visible to the agent, so drift is caught where it happens. The witness is invisible to the agent, so gaming is caught where it hides. Nobody else ships both.
- **No model in the verdict.** `decide()` is a pure function of the run's frames. Put the source on the website.
- **Third parties depend on the record.** `oxagen dod verify` runs with no account and no network. The day an auditor runs it, Oxagen is infrastructure.
- **The meter follows the proof.** Charge for proven runs. Report runs and governed actions as secondary meters.
- **Sixty seconds to wrap Claude Code.** Two hooks. The first screen shows your own numbers.

## The buyer and the sentence they repeat

Engineering lead running terminal agents. After a month: "I stopped reading agent PRs to find out if they were done."

Secondary reader: the CFO, who reads the Spend page without translation.

## The demo, in order

Type a prompt in Claude Code. Show the lock. Let the agent try to stop and get blocked with the failing ids. Let it finish and hold. Open the run, show the frame with its cost beside it. Hand the export to a second laptop and run verify. Twenty minutes, one blocked stop, one held dod, one offline verification.

## Competitive framing

Never name a competitor in copy. Describe the category behavior instead: "tools that record," "scores written after the fact," "a second model grading the first." The reader supplies the names.

## What not to say, and why

- **Trust layer, safety, guardrails.** These sell fear. The buyer is not afraid; he is annoyed.
- **AI-powered verification.** The verdict has no AI in it. That is the point.
- **The fourteen oracles, the ladder, the rating, Vera.** Year-two story. Telling it now is the surface-area problem.
- **Stamp.** Belongs to the witness. The dod settles; it does not stamp.
- **Proven, for anything the dod did.** A held dod means done. Proven is the witness verdict `flipped` and nothing else.
