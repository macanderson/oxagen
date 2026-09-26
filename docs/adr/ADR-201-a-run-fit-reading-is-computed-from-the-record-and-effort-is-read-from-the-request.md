# ADR-201: A run's fit reading is computed from the record and its effort is read from the request

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** run evidence, tacho
- **Related:** issue #3893 (Model fit), issue #3891 (effort and the wall
  split), issue #3971 (rules and taint on a decision), ADR-182 (the server
  folds the transcript), ADR-184 (a runner seam into the durable jobs),
  ADR-070 (the taint floor), ADR-198 (an agent carries no definition file),
  roadmap `mockups/pages/run-cost.md` (Model fit).

## Context

The Run page's Model fit panel says whether the model class and the effort
setting were the right size for a run. Four things were wrong with it.

1. **The page computed the reading.** `features/run/fit.ts` read the run row
   and the client's metrics on every render. Nothing stored the reading, so
   nothing could say which figures it read, when, or which seal. A person
   could not cite it, and a move it argued for pointed at nothing.
2. **The effort was never read.** No producer recorded the effort a model
   request carried. The rig printed a harness-reported `effort high` while
   the Cost tab's effort card said not captured, so the two panels disagreed.
3. **The move was a stub.** "Move this agent to haiku" was a disabled button.
   Nothing could make the change the reading argued for.
4. **A decision named no rule.** The tacho hook recorded the rule that
   decided a call as one joined string (`Bash(git add:*) and Bash(git
   commit:*)`). The transcript dropped it, and the Policy tab printed "not
   recorded" for rules and taint.

The issue asked for "the model that wrote it" as the reading's provenance.
The design of record says the reading is "computed from the record, not
written by a model". No model writes it, so that provenance does not exist.

## Decision

### 1. The reading is computed from the record after the seal

`runFit` in `@oxagen/oxagen/run-fit` is the one rule, versioned
`run-fit/v1`. It is pure. It reads the run's prompts, turns, steps, failed
tool calls, and output and reasoning tokens, and never a model's prose.

- **Model class.** A first-try run of at most 3 turns or 12 steps argues one
  rung down the vendor's own family. A run the operator prompted again, or
  with a failed tool call, argues one rung up, whatever its size. Anything
  else fits, and so does a class at the end of its ladder. A class on no
  ladder gets no verdict. The reading is never keyed on reasoning share,
  which is a fixed fraction of output per model family and so describes the
  model, not the run.
- **Effort.** The ladder is `low`, `medium`, `high`, the three words every
  vendor with an effort setting accepts. A first-try run that spent more than
  a fifth of its output reasoning argues one level down. A redone run argues
  one level up. An effort off the ladder (Anthropic's `xhigh` and `max`) and
  a run whose figures were not read both read `fit`, and `fit` names no move.
- **Unseen effort.** With no effort in the record the verdict is `unseen`,
  with why: `not_sent` where Oxagen proxied the calls and the request carried
  none, `not_proxied` elsewhere.

### 2. The reading is stored with its provenance

`tacho.sessions` and `agent.agent_runs` each carry `fit_reading` (the reading
less its provenance), `fit_method`, `fit_read_at` and `fit_sealed_at`, set
together by a CHECK. `get_run` answers `run.fit` only when `fit_sealed_at`
equals the run's `sealedAt` and the method is one this build reads. A live
run, a run with no reading, and a reading of an earlier seal all answer null.

### 3. A durable job writes it through a runner seam

`cost.run-rollup` sends `run/fit.requested` once the run's `cost.run_totals`
row lands, because the reading reads that row's tokens. The `run.fit` job
(concurrency one per run) calls a runner that `@oxagen/handlers/register`
installs at boot, as the steering sync does (ADR-184). The runner
(`handlers/src/lib/run-fit.ts`) reads the run the way the Run page does:

- the row `list_runs` builds, for turns, steps, class, tier and seal;
- the effort as `get_run` answers it (`runEffortOf`, below);
- `get_run_transcript`'s figures over the same frames, with the same word
  marking, so a prompt of only whitespace counts nowhere (ADR-182).

The job is not part of `run.enrich`. The reading calls no model, so neither
the enrichment switch nor the spend cap gates it. `modelTierOf` stays in
`@oxagen/handlers`, since the runner runs there; nothing needed to move.

### 4. The card draws the move it argues for as a stub

A card that argues for a move draws it as a disabled button that names the
move ("Move this agent to haiku", "Set effort to medium"). The line beside it
says no contract changes an agent's model class, or its effort setting, from
the Run page yet.

This branch first offered the move as a `commit_agent_definition` pull
request against two top-level keys of the agent's definition file, `model`
and `effort`. ADR-198 (#4376) removed that write and the definition file
while this branch was open. An agent is now one operator on one runtime with
one harness, and its version config carries its budget and containment. No
write sets its model class or effort. So the move stays a stub, the same
shape the panel had before this record.

When a write for an agent's model class or effort exists, the card calls it
and names the class or level the reading gives: the vendor class alias
(`haiku`, `sonnet`, `opus`, `nano`, `mini`, `flash-lite`, `flash`, `pro`) or
the level (`low`, `medium`, `high`). `get_run.fit` is on the API and MCP.

### 5. A run's effort is read from the request ahead of the harness

The model proxy reads the effort from the request body the vendor received
and seals it as `request_effort` on the `llm_call` frame: Anthropic
`output_config.effort`, OpenAI Responses `reasoning.effort`, Chat Completions
`reasoning_effort`. `get_run` answers `effort` with `effortSource`:

1. the latest `request_effort` (`request`);
2. the latest `effort_level_setting`, then the latest frame `effort`
   (`harness`);
3. the effort the session row holds (`harness`).

`runEffortOf` in `handlers/src/lib/run-work.ts` is that order, and both
`get_run` and the fit runner call it. The frame projection applies the same
order per frame. The rig and the effort card print the effort from one app
helper, so they cannot disagree.

### 6. The wall split stays on the transcript

`cost.run_totals` gets no `model_ms`, `tool_ms`, `wait_ms`, tool-failure or
batch columns, and `get_run_cost` is unchanged. `get_run_transcript.figures`
is the one per-run derivation of the split, the failures, the families and
the batches (ADR-182). A batch is the fold's reading, with Claude Code's
recorded `batch_index`. A rollup column arrives only with a reader that needs
it across runs, and it is computed by calling `transcriptFigures`.

### 7. A decision names its rules in evaluation order and leaves taint unassessed

A decision frame carries `policy_rules`, the rules that decided in
evaluation order: one for a deny or an ask, and each shell segment's rule,
once, for a compound allow. `policy_rule` keeps the joined form for older
readers and `tacho.session_commands`. A row sealed before the list reads its
joined rule as a list of one, kept whole, because " and " can sit inside a
rule's own pattern.

The Policy tab prints each rule in mono. A mandate gate cites itself as
`mandate:<publicId>:<gate>`, and that rule links to the mandate's page. A
permission pattern and a workspace decision rule have no page of their own,
so they print without a link.

`TranscriptDecision.taint` is null, which means no producer assessed taint.
An empty list would mean one assessed the inputs as clean. Nothing records
taint (ADR-070), so there is no taint column until a producer exists.

A control-plane refusal of an MCP call answers JSON-RPC `-32002` with
`data.ruleIds`, and the gateway seals those as `policy_rules`. The gateway
reads that shape now. The control plane cannot answer it yet: xmcp turns
every error a tool throws into an `isError` result, and rethrows only
`UrlElicitationRequired`, so a tool cannot produce `-32002`. The producer is a
follow-up.

The daemon writes a gateway refusal's reason as `policy_reason_code` and
`policy_reason_digest`, which the envelope declares (`gatewayFrameBody`). It
used to write `policy_reason`, which no body declares, so the recorder moved
it into `attrs`, where no reader of a decision looked.

## Consequences

- The reading can be cited: its rule, its figures, when it was read, and the
  seal it read are on the run. A reseal reads the run again and replaces it.
- A run sealed before this change has no reading until it seals again.
- The reading changes nothing on its own. The card's move stays a stub
  until a write sets an agent's model class or effort.
- The page computes no figure the server did not, so the rig, the badges,
  the cards, and `get_run` answer the same reading.
- A request body that carries no effort is recorded as such, and the page
  says the model used its own default, never a guessed value.
