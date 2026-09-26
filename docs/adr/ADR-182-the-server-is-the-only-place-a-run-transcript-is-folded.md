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
   duration, the entry it repeats, each item a recall listed with whether
   it reached the model and why it was cut, and the `tool_use` blocks a
   tool entry claims. On the response, it covers the count per kind, the
   page figures, and the search matches.
3. A fact is never written into a label for a client to parse.
4. `kinds` filters entries after the fold, so a filtered transcript shows the
   same steps as an unfiltered one.
5. Search runs on the server, over the folded entries and their retained
   text. The page sends the query after the operator stops typing, and a
   read reports how many retained halves it did not search.
6. The browser keeps presentation only: drawing an entry's rows, cutting a
   line to width, reading a tool's body into display fields, and reconciling
   pages.
7. The frames the fold reads are composed once, by `readTranscriptFrames`
   in `@oxagen/run-ledger`: each subagent chain spliced in where it was
   spawned, a harness's late report of a metered call uncounted, and each
   model call once, to one frame cap. `get_run_transcript` and
   `run.summarize` pass it their store reads and fold what it returns.

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
  and has its own issue, #4308.
- The page's figures and counts share the transcript read's 10,000-frame cap,
  and say so when a run passes it, as they did before.
- A search can read every retained body of a run, so it is bounded per read
  and says what it left unsearched.
- At `steps`, which prompts and replies draw nothing, and which reply repeats
  words just shown, are settled from their words over the whole run, so the
  counts match the rows. A body never changes, so the server keeps, per
  process, the digest of each body's trimmed words and whether it has any,
  never the words, keyed by tenant, reference and digest. A later page or
  live read reads only the word bodies it has not read, and every half a
  page shows is read from the evidence store. `everything` and `turns` read
  only the prompts' words, for the figures, which the cache holds once the
  run has been read at `steps`. Recording that digest and blank flag at
  ingest would let the read settle both facts with no body read at all; that
  needs a ClickHouse column and is issue #4331.
- Only a body read whole settles either fact. A body that could not be read,
  for any reason, leaves its entry as the fold said, so a read that fails
  never hides a row that a live page already holds or takes it out of a
  count.
  A failure that will repeat is remembered for a minute: the store has no
  object, its bytes no longer hash, or its key no longer opens it. Erasure
  destroys the key and leaves the object, so the last case is how an erased
  body reads. A kept digest answers only while its key still opens bodies,
  which each read learns from the bodies it reads, reading one body again for
  a key it has not read. So a process that read a run before erasure and one
  that never did give the same answer, for at most one read per key.
- A chip selects what the Run page draws under it, so a chip's count in
  `counts.kinds` is the count of what the chip shows. `prompt` is the
  operator's prompt and no longer a model call's request, `responses` takes
  a reply the harness reported with its words kept and leaves out a model
  response kept as a digest alone, `seal` is the run's own stop rather than
  the chain's checkpoints and gaps, and `usage` takes token counts reported
  without a cost and the effort a model call ran at. API and MCP callers
  that filtered on those chips see the new selection.
- Which rows a kept model reply draws, its words or only the tools it
  called, needs its body read, and a count reads no body. So the Run page
  draws a row under `responses` for every model step that answers it: what
  the model said, or a line naming what it called when it said nothing in
  words. A model step with nothing to draw, a call still waiting on its reply
  or one kept as a digest with no figures, is `quiet`, unless it failed: a
  failed step draws one failed row, so the errors count still holds it. The `figures.prompts`
  figure counts a prompt as the `prompt` chip does.
- The Run page draws a row under a chip only when the entry's `kinds` carry
  that chip, and marks a row failed only when the entry's `error` says the
  errors count counted it. The server
  counts `thinking` from the reasoning tokens a provider reported, and
  `tools` from tool steps, so a kept thought of a step that reported none,
  and a call only the reply records, are drawn under `responses`. A failed
  result of such a call shows in its row and makes no error.
