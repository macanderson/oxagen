# ADR-242: One model reply is one step, however many parts it arrives in

- **Status:** Accepted
- **Date:** 2026-10-01
- **Owners:** app, evidence
- **Amends:** ADR-191 (the consequences that leave a reply's further block as
  a difference between the fold and the query).
- **Related:** issue #4351, issue #4308, ADR-182 (the one step fold), ADR-199
  §1 ("A step is one model call or one tool call").

## Context

A wrapped Claude Code session writes one transcript record per content block
of a model reply: a text block, a tool-use block. The host marks each block
after the first as a later sighting of its own source
(`oxagen.llm_call_duplicate_of` equal to the frame's source).
`withoutDuplicateModelCalls` keeps those blocks exactly when the reply's first
block stays.

The Run page counted them two ways. The transcript fold
(`packages/run-ledger/src/transcript-steps.ts`) made each kept block a model
step of its own (rule 4). The Cost tab's query for a wrapped run
(`selectTachoTurnGroups`) counts an `llm_call` with no duplicate mark, so the
same reply was one model step there. A further block between an unkeyed tool
request and its receipt also parted the two in the fold, so the turn drew two
tool calls on the Transcript tab and one on the Cost tab.

Mac decided on 2026-10-01 that one reply is one step, which is what ADR-199 §1
and the fold's own header already said.

## Decision

1. **The fold gathers a reply's parts into one model step.** Within a turn, a
   frame marked a later sighting of its own source joins the step of the
   reply's first part: the frame on the same chain, with a shared call key
   (`request:<id>` or `message:<id>`) and the same source, that carries no
   mark. A part whose first part is not in the turn joins the first such part
   that is, which then stands for the reply. A step still never crosses a
   turn boundary.
2. **A later sighting does not part an unkeyed tool call.** Rule 3 passes
   over a later sighting of a model call on its chain, as the query leaves it
   out of its letters (ADR-191 decision 3). A request and its receipt with a
   further block between them are one tool call in both.
3. **The query does not change.** It already counts one model call per reply
   and leaves every later sighting out of rule 3.
4. **One test holds the two together.** The split reply in
   `run.turns.get.integration.test.ts` now asserts that the query and the
   fold answer the same turns, one model step and one tool call.
   `run-frames.test.ts` folds the same reply and expects one model step that
   holds both parts.

## Consequences

- The Transcript tab draws one model row per reply in a wrapped run the proxy
  did not observe, and the row holds every part as a member. The Cost tab and
  the Transcript tab give the same model step count and the same tool step
  count for such a turn.
- A model step's `frames` counts its parts, and its duration runs from the
  first part to the last.
- Two differences ADR-191 named between an unkeyed request and its receipt are
  gone with decision 2: a later sighting with a richer body that replaced the
  first, and a later sighting whose first sighting is not among the run's
  frames. The second still differs on the model count. The fold draws it as a
  model step, as the only copy of the call, and the query counts none.
- A subagent chain that no spawn frame names, beginning between an unkeyed
  request and its receipt, still differs, as ADR-191 says.
