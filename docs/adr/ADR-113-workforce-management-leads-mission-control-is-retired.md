# ADR-113: Workforce management leads, and Mission Control is retired as a product name

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** Mac (positioning), platform
- **Numbering:** 112. ADR-102 to ADR-112 were taken on `main` while this branch was open, two of them twice.
- **Supersedes in part:** ADR-067 (the product name only). ADR-067's scope
  rules, its completion rule, its ruling that the agent control plane is the
  technical category, and its ruling that the message registry is the source
  of copy all stand.
- **Related:** `docs/VISION.md`, `oxagenai/oxagen-brand` `messages/` (the
  message registry) and `skills/oxagen-branding/` (the copy every agent
  reads), ADR-066 (the two names ADR-067 replaced), ADR-043 (Oxagen governs
  agents, it does not run them)

## Context

GitHub shipped a control-plane product named Mission Control. Oxagen has led
with Mission Control since ADR-067 on 2026-09-15, four days earlier.

The review on 2026-09-19 asked one question. Can two products in the same
buyer's field of view carry the same name? They cannot, and the smaller one
loses. A buyer who hears Mission Control from the platform their engineers
already log into every day will not hear Oxagen's version of it, and every
search result, ad and conference sentence Oxagen pays for would carry someone
else's recall.

Three options were on the table. Hold the name and argue the distinction.
Pick a second metaphor and spend the launch teaching it. Lead with the job the
buyer already has a word for. The founder chose the job: a company that runs
agents has a workforce, and the person accountable for it is doing workforce
management whether or not anyone has named it that. A metaphor has to be
taught. A job does not.

The technical category does not move. The agent control plane is what Oxagen
is to an architect, it is contested by nobody, and ADR-067 settled it.

## Decision

1. **The lead headline is "Your agents are a workforce now. Manage them like
   one."** It opens on the reader's situation, not on the product.
2. **The product category and the eyebrow are "workforce management for
   autonomous agents."**
3. **The technical category stays the agent control plane** (ADR-067),
   lowercase in prose.
4. **The one-sentence definition is:** Oxagen is workforce management for
   autonomous agents: give each agent an identity, set its authority and
   budget, equip it with tools and skills, and review what it did and what its
   operators spent, through a shared agent control plane.
5. **The operator review is the rate job's named surface.** One page per
   person, read from the record and never estimated:
   - spend by operator, agent and workspace, the same rows the Spend page
     prices, cut by the person who started the run;
   - outcome per dollar for bounded tasks;
   - prompt habits from the recorded turns: turns to completion, restarts on
     the same task, steering overridden by hand instead of written as a rule,
     routed requests the operator approved every time;
   - one recommendation per habit, worded as a rule the operator can adopt.

   **The honesty rule:** the review reports what the record shows and never
   grades the person. No score, no ranking, no performance verdict. The line
   is "Your agents get a mandate. Your operators get a review."
6. **In current prose and in the product, the place an operator works is
   Oxagen or the operator console.** "Oxagen" is the app. "The operator
   console" is lowercase and descriptive, for the sentence that needs to name
   the place rather than the brand. Neither is a capitalized product name, and
   "Mission Control" appears in no current copy.
7. **What stays:** Fleet as the page name and as the operator's word for the
   enrolled agents, workforce for the population of agents, operator for the
   person, mandate for the unit, tacho for the recorder, and the agent control
   plane for the category.
8. **What is left in place on purpose, because a path and a history are not
   copy:**
   - Accepted ADRs keep their text. ADR-067 and ADR-081 still say Mission
     Control, because that is what they decided on the day they were written.
     Only the index line for ADR-067 in `docs/adr/README.md` gains a note that
     the product name is superseded here.
   - `docs/specs/mission-control/` and `docs/mission-control/` keep their
     paths. Each gains one line at the top saying the product name was retired
     by this ADR and the folder keeps its name as a path. Renaming a folder
     breaks every citation in the tree and buys nothing.
   - `CHANGELOG.md` is history and is not edited.
   - A code comment or a doc that cites "Mission Control spec §14" or the
     Mission Control mockup is citing a document by its title, and stays.
9. **Dispatch is a candidate product name, recorded here and decided by the
   founder alone.** It is not in use, not in the registry, and no surface
   ships it until the founder says so.
10. **The message registry stays the source of copy** (ADR-067). A line that
    is not in `oxagenai/oxagen-brand` `messages/` is not approved copy,
    whatever this ADR says about the direction.

## Consequences

- The rename lands as one PR set: the vendored branding skill, `docs/VISION.md`,
  `CLAUDE.md`, `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, the `apps/app`
  strings, the docs site, the CLI strings, the `apps/web` posts, and the
  roadmap repo. A half-renamed surface reads as two products.
- The Vision Gate judges every PR diff against the rewritten `docs/VISION.md`
  from the merge onward, so work is measured against workforce management and
  against the operator review, not against the retired name.
- `messages.py --check` in the brand kit rejects "Mission Control" in live
  copy, so the retirement is enforced rather than remembered.
- The operator review is now a named surface with a drift test behind it. A
  reporting page that grades a person fails the honesty rule in decision 5 and
  is not that surface.
- Oxagen keeps the recall it built in four days, which is close to none. The
  cost of the change is this PR set. The cost of holding the name compounds
  with every dollar spent on it.
