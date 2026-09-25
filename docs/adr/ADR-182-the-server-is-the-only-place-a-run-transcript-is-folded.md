# ADR-182: The server is the only place a run's transcript is folded

- **Status:** Accepted
- **Date:** 2026-09-25
- **Owners:** app, evidence
- **Amends:** ADR-166's amendment of 2026-09-24 (the one derivation of the
  Run page's figures moves from `features/run/metrics.ts` to the server),
  ADR-167 (`features/run/actions` reads the transcript port).
- **Related:** issue #3375, issue #3942, issue #4083, issue #3994 (closed into
  #3375), ADR-058 (the transcript is derived on read), ADR-140 (one tool call
  seals one frame).

## Context

`get_run_transcript` folds a run's frames into turns and steps in
`packages/run-ledger/src/run-frames.ts`. The Run page never read a folded
zoom. It read `everything`, one entry per frame, and folded the frames again
in `apps/app/src/features/run/transcript-model.ts`, with its own pairing,
call gathering, subagent nesting, row rules, and page figures. The contract
invited this: its `callId` field said a client that rebuilds steps at
`everything` pairs halves on it.

The two folds disagreed. On four frames that share one call key, the browser
drew one call twice (#3994) and the server made three entries. At `steps`,
the server buried each turn's prompt in the step before it. The browser
counted steps one way, `get_run_turns` another, and the filter chips a third.
Facts crossed the boundary as labels (`create_workspace parked apr_…`,
`deny Bash`) and the browser parsed them back. A tail page went through a
second mapper that dropped the assembled reply, so the browser carried a
third copy of the provider message parser. Every change to how a run reads
had to be made twice, and more than once it was made in one place only.

On 2026-09-25 Mac chose one fold, on the server, on the principle that the
same logic is never implemented twice.

## Decision

The server is the only place a run's transcript is folded. The browser
presents the contract's entries and does no pairing, grouping, folding, or
counting of frames of its own.

1. `@oxagen/run-ledger` holds one step fold. The `steps` zoom is that fold.
   `turns` groups it by turn, so the two zooms cannot disagree. `everything`
   stays one entry per frame.
2. Every fact the browser used to derive is a field of the entry or of the
   response. On the entry, that covers its key, the spawning step, the
   outcome, the approval id, the gates, the subject, the tool family, the
   duration, the entry it repeats, the recall tally, and the `tool_use`
   blocks a tool entry claims. On the response, it covers the count per
   kind, the page figures, and the search matches.
3. A fact is never written into a label for a client to parse.
4. `kinds` filters entries after the fold, so a filtered transcript shows the
   same steps as an unfiltered one.
5. Search runs on the server, over the folded entries and their retained
   text. The page sends the query after the operator stops typing, and a
   read reports how many retained halves it did not search.
6. The browser keeps presentation only: drawing an entry's rows, cutting a
   line to width, reading a tool's body into display fields, and reconciling
   pages.

A rule written in two places drifts, and the copy nobody remembers is the one
that ships the defect. A rule about how a run reads is a change to
`@oxagen/run-ledger` and the contract, tested there, and the API, MCP, the
Run page and `run.summarize` all get it at once.

This supersedes the contract's guidance that a client rebuilds steps at
`everything`. It also supersedes the `steps` fold in which every other frame
joins the step before it, the `kinds` rule that filtered frames before the
fold, and the client fold introduced with #3345.

## Consequences

- API and MCP callers of `steps` and `turns` see different entry counts.
  Events are entries, and each call is one entry however many sources sealed
  it. The response shape only adds fields, and existing inputs keep their
  defaults.
- `run.summarize` reads the same steps the Run page draws.
- The ledger path of `get_run_turns` counts steps from the fold. The wrapped
  path still counts in ClickHouse SQL, a second definition, until each frame
  carries its step key from ingest. That change needs a ClickHouse migration
  and has its own issue.
- The page's figures and counts share the transcript read's 10,000-frame cap,
  and say so when a run passes it, as they did before.
- A search can read every retained body of a run, so it is bounded per read
  and says what it left unsearched.
- A chip selects what the Run page draws under it, so a chip's count in
  `counts.kinds` is the count of what the chip shows. `prompt` is the
  operator's prompt and no longer a model call's request, `responses` takes
  a reply the harness reported with its words kept, `seal` is the run's own
  stop rather than the chain's checkpoints and gaps, and `usage` takes token
  counts reported without a cost. API and MCP callers that filtered on those
  chips see the new selection.
