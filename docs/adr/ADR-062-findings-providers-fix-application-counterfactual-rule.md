# ADR-062: Findings: providers, fix application, the counterfactual rule

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Refines:** ADR-060 (the cost rollup this job reads; `list_waste`, whose
  one cause stays a waste figure and not a finding).
- **Related:** the Mission Control spec `2026-09-11-oxagen-mission-control-spec.md`
  §12.4, §12.8 and App. E; `apps/app/ARCHITECTURE.md` §1.1 (Spend keeps
  attribution and costed findings; reconciliation is cut), INV-09, INV-10,
  INV-14, INV-28, INV-29; GitHub issue #2963 (the lane) and #2962 (the rollup it reads). The number
  follows ADR-061, which two lanes in flight use.

## Context

The Spend page leads with findings: specific, costed problems an operator can
act on, each with the runs that prove it and a fix. Issue #2963 left three
decisions to the maintainer, each with a recommendation. The maintainer's
scope note of 2026-09-14 keeps costed findings with evidence and a fix and
cuts provider-invoice reconciliation and its tab.

What the tree records today decides what a detector can prove. The cost
rollup (`cost.run_totals`) prices every model frame by token class. The tacho
hook records each tool call once with its input and output digests and a
mutating flag, and the OTel tool span records its result tokens. Prompt
composition (`tool_definition_tokens`, `context_frame_tokens`), step grading,
route tiers and a per-turn system-context digest have no recorder.

## Decision

### 1. Provider exports

No provider usage importer ships. Decision 1 chose which provider exports
reconciliation would import first; the scope note cuts reconciliation, so
`import_provider_usage`, `get_reconciliation`,
`resolve_reconciliation_exception`, `cost.provider_usage`,
`cost.reconciliations` and `cost.reconciliation_exceptions` are not built.
The recommendation (Anthropic and OpenAI usage exports by key and day, then
the OpenRouter gateway; Bedrock and Vertex later) stands as the order if
reconciliation returns to scope.

### 2. How a fix is applied

The recommendation is adopted as the rule: a finding whose fix is a
definition or grant change applies it as a direct governed write on the
subject (a route pin through `update_agent_def`, a narrowed grant for
tool-list bloat), and a finding whose fix is steering timing opens a Context
PR.

No kind this release detects has such a target. The four shipped kinds fix
something Oxagen does not hold: the agent's request builder (cache writes
never read), its harness result cache (repeated shell commands), its loop
(duplicate tool calls), or a tool's page size (unpaged results). The mockup's Fix
dialog draws these as help articles, "Oxagen cannot change it for you; it
can show you exactly where", and says Oxagen records the change when the
operator applies it. So the write is `record_finding_fix`: org Owner or
Admin, checked in the handler; `mutates: true`; on the agent surface it waits
for a person's approval. It sets the finding `applied` with the invocation's
request id as `applied_action_id`, the id the kernel's audit row carries. The
detectors then cite only runs that started after the decision, which is what
makes the saving attributable on Spend. `dismiss_finding` records a decision
the same way without an action id.

The issue names the write `apply_finding_fix`. ADR-025's verb list has no
"apply", and the write records a change rather than making one, so it is
`record_finding_fix`. The direct governed writes and the Context PR path land
with the first kind whose fix is a definition, grant or steering change:
tool-list bloat and wrong tier wait on their recorders (the detector table
below), and duplicate tool calls move to a Context PR
once the proposal contracts of #2961 merge.

### 3. The counterfactual rule

The recommendation is adopted. A saving is measured minus counterfactual over
the runs a finding cites, at the price each run paid:

- **Measured** is what the cited calls cost. For cache writes it is the
  run's cache-write cost by class from the rollup. For a tool call it is the
  call's result tokens at the run's input price.
- **The run's input price** is the input the rollup priced for the run over
  the input tokens it carried. An `estimated` run, or one whose input the
  book priced at nothing, has none.
- **Counterfactual** is the same work at the alternative the finding names:
  the written prefix sent uncached, a result the run already held (zero
  tokens), or a result paged at 4,000 tokens. A result another run fetched
  has no token counterfactual: the new run's context carries the result
  tokens whether the tool ran again or a workspace cache answered.
- **Confidence** is the share of cited calls the counterfactual covers: a
  call is covered when its run has an input price and, for a tool call, its
  result tokens were recorded. `high` at nine in ten or more, `medium` from
  half; under half, or under one cent of saving, the finding is not written.

A finding is written only with at least one cited run; the table refuses a
row without one.

### 4. The job

`cost.findings` runs on `cost/findings.requested`, which the run rollup sends
once a sealed run's rows land, with events batched per workspace for up to
five minutes, so a burst of seals costs one pass. `cost.findings-nightly` at
02:00 UTC passes over every workspace with a run in the trailing 30 days or
an open finding, so a workspace whose runs stopped gets a pass with no runs
and its open findings age out. A pass reads the window's run rows and at most
200,000 tool calls, detects, and in one transaction deletes the open findings
it no longer proves and upserts the rest on `(workspace_id, fingerprint)`
where the row is open, so a finding's public id survives passes. The
transaction locks the open rows and re-reads the latest `decided_at` per
fingerprint; a fingerprint whose decision the pass did not detect with is left
to that decision. The comparison is between stored `decided_at` values, so a
decision stamped by a clock behind the worker's is still seen. At most ten
advisory findings per kind are kept, largest saving first. A finding that
counts toward the unproductive spend headline is never cut (ADR-208, item 11).

`list_findings` annualises each finding's saving over its own window and
divides by the priced spend of the findings' span scaled the same way. A
window or span shorter than seven days scales as if it were seven days: a
finding decided once and re-proven minutes later covers minutes of runs, and
a year over those minutes would multiply its saving by the tens of thousands.

### 5. Store and contracts

`cost.findings` is a standard tenant table (org and workspace, RLS). The
contracts are `list_findings`, `get_finding_evidence`, `record_finding_fix`
and `dismiss_finding`, all `noBillingGate: true` (INV-28). The reads carry
`list_waste`'s roles; the two decisions are org Owner or Admin in the handler
(INV-29).

## Detector table

The detectors mirror spec §12.8 row for row. `packages/billing/src/findings.ts`
is the implementation and `findings.test.ts` its positive and negative cases.
Each call is claimed by at most one finding, in the order the tool-call rows
are listed. The job reads a trailing 30-day window per workspace:
`cost.run_totals` rows that started in it, and at most 200,000 hook tool calls,
newest first. When the read reaches that cap, the tool-call kinds' window
starts at the oldest call read, and each such finding's `window.from` says so.
A finding someone applied or dismissed cites only runs that started after the
decision, and its window starts at the decision.

### Shipped

| §12.8 row or mockup kind | `kind` | Level | Detected from | Counterfactual |
|---|---|---|---|---|
| Cache writes never read | `cache_writes_never_read` | operator, or agent when the run names no operator | `cost.run_totals.tokens`: `cache_write_5m + cache_write_1h > 0` and `cache_read = 0`; the money from `breakdown.models[].costByClass.cache_write_*` | the written tokens at the run's input price |
| Repeated shell commands (mockup) | `repeated_shell_commands` | tool `Bash` | `tacho_events` hook `tool_call`: the same `tool_name`, `tool_input_digest` and `tool_output_digest` as an earlier call of the run | nothing: the result was already in the window |
| Duplicate tool calls | `duplicate_tool_calls` | agent (`agent_key`) | the same match on a tool with `tool_is_mutating = false` | nothing |
| Unpaged results (mockup) | `unpaged_results` | tool | `tool_result_tokens` above 20,000, from the OTel tool span joined on `tool_use_id`, else the hook row's estimate (amendment of 2026-10-03) | the same result at 4,000 tokens |

The tool-call kinds price a call's `tool_result_tokens`. A hook call with no
span carrying that figure was cited and not covered until the amendment of
2026-10-03, which prices the hook's estimate and labels the figure
`estimated`.

### Waiting on a recorder

These rows have no finding in this release, and no detector writes their
kind. Each names the field no recorder in the tree writes, so there is no
cited frame to prove it or no measured cost to price. A row joins the table
above in the change that records its field.

| §12.8 row or mockup kind | Reads | What is missing |
|---|---|---|
| Refetching a stable list (mockup) | a read-only tool's identical result of the same input in an earlier run | the saving is the tool's execution, and the result tokens enter the new run's context either way; no recorder writes a per-call tool execution cost, or the size of a not-modified or diff response |
| Cache misses after a stable prefix changed | a system-context digest per turn | a model call the proxy did not carry has no digest, by the amendment of 2026-10-02. A proxied call has carried one since #4505, and detector 3 (`cache_busts`, ADR-208) reads it |
| Tool-list bloat | `cost.run_totals.tool_definition_tokens` | a model call the proxy did not carry has no tool definition count, by the amendment of 2026-10-02. A proxied call has carried one since #4505, and detector 2 (`standing_context`, ADR-208) reads it |
| Context bloat | `cost.run_totals.context_frame_tokens` and the citation rate from `context_use_feedback` | for Claude Code the column counts only the context Oxagen's own hooks handed the agent, by the amendment of 2026-10-03, and no recorder writes `context_use_feedback` |
| Retry storms | per-call provider errors with the cost of each retry | a failed provider call carries no billed tokens in either frame store, so a storm has no measured cost to save |
| Unproductive tail | the step after which nothing was kept | `productive_ratio` and step grading are null until the grading lane writes them |
| Wrong tier | step shapes and the tier each call took | no recorder classifies a step or records a route tier |
| Budget headroom | spend against `billing.spend_budgets` | a budget resize changes a ceiling, not the money spent, so there is no saving to price |

## Consequences

- The Spend page can lead with findings whose every number traces to frames
  and the rollup; nothing on the wire is estimated by a reader.
- Four §12.8 rows (cache misses after a prefix change, tool-list bloat,
  context bloat, wrong tier), the unproductive tail and the mockup's
  refetching a stable list appear only when their recorders land; retry
  storms and budget headroom carry no saving to price.
- A saving is a lower bound: a tool result re-read by later turns of the run
  is priced once, on the call that returned it.
- A workspace whose tool calls exceed the read cap in 30 days gets tool-call
  findings over a shorter window, stated on each finding.
- A finding whose window is under seven days has an annualised figure and a
  share below its own run rate: the seven-day minimum trades that for never
  scaling a few minutes of runs to a year.

## Amendment 2026-10-02: what each recorder path measures (#4493)

#4505 gave the Claude Code recorder the three token sources and the system
context of a model call. Each `llm_call` frame can carry
`tool_definition_tokens`, `context_frame_tokens`, and `steering_tokens`, each
with a `_basis` of `reported` or `estimated`. It can also carry
`system_context_digest`, one digest over the ordered parts of the system
context, and `system_context_parts`, each part's kind, name, digest, and token
count. A part never carries its text. The rollup sums the three sources into
`cost.run_totals`, and a source no counted call measured stays null.

A recorder sets a member only when it can see what the member measures. An
absent member means nothing measured it. It never means zero.

| Path | What it sees | What the counted row carries |
|---|---|---|
| Loopback model proxy (`fidelity = 'proxy'`) | the request body | the tool definition count, the steering count, the system context digest, and its parts |
| Loopback model proxy, on a request that declares no tools | the request body | the tool definition count (zero), the system context digest, and its parts, with no steering count and no steering part |
| OTel `api_request` record or transcript `assistant` record, on a session the proxy did not carry | usage and ids, never the request | the steering count alone, on a call of the session's own conversation |
| An OTel `api_request` record of a side call, or one that names no `query_source` | the same | nothing |
| A subagent's OTel or transcript row | the same, on a child chain that was delivered no steering manifest | nothing |

- **Steering on both paths.** Claude Code delivers steering in
  `SessionStart` context, which rides the conversation, so even the request
  cannot say which bytes are steering. The session's `steering.manifest`
  frame can. So both paths take the steering count from the manifest. On a
  call of the session's own conversation, a call the proxy did not carry
  gets the same count a proxied call would.
- **Only the session's own conversation carries steering.** Claude Code
  also makes side calls, such as a session title or a check of a Bash
  command's prefix. A side call sends a short prompt of its own, without the
  conversation the steering rode in on, so it takes no steering count. Each
  path tells a side call apart with what it can see:
  - The proxy reads a request that declares no tools as a side call. Claude
    Code's main thread sends the session's tools on every call, and its side
    calls send none. This is a reading of the request's shape, not a label
    Claude Code sets. It only ever takes the count away. A session run with
    every tool turned off loses its count, and a subagent's proxied call
    still takes the root session's count, as #4505 already noted.
  - An OTel `api_request` record names the subsystem that made the call in
    `query_source`. `repl_main_thread`, a value that starts
    `repl_main_thread:`, and `sdk` (print mode, `claude -p`) are the
    session's own conversation. Every other value takes no count, `compact`
    included. A record with no `query_source`, from an older Claude Code,
    cannot say which call it is, so it takes no count either.
  - A transcript `assistant` record is a message of the conversation itself.
    Claude Code writes no side call to the transcript.
  - A proxied request the recorder cannot read or resolve keeps the count.
    Its tools are out of sight, and the usual cause is a request too large
    for the proxy to hold, which a side call's short prompt never is.
- **The two paths can disagree on one call.** A compaction is the known
  case. Its OTel record (`compact`) takes no count. Its proxied request takes
  one when it declares tools, and the rollup joins that count back when the
  OTel row is the counted one. On a session the proxy did not carry, a
  compaction has no steering count.
- **No digest without the request.** A digest over the steering parts alone
  would read as the whole system context. Detector 3 would then read a
  changed tool as an unchanged prefix. On a call the proxy did not carry,
  the digest and the parts stay absent. Detector 3 then names no changed
  part for the call, and it leaves out a rewrite past the cache lifetime as
  one of unknown cause (`packages/billing/src/findings/cache-busts.ts`).
- **Context frames stay absent for Claude Code.** Its hook context rides the
  conversation, and nothing in the request marks it apart (ADR-200), so any
  count would be a guess. The envelope, the column, and the rollup carry the
  member, so a harness that can measure it fills it with no further change.
  The amendment of 2026-10-03 below fills it from Oxagen's own hook answers.
- **Every count is an estimate today.** Claude Code reports none of the
  three, so each count is `budgetTokens` (UTF-8 bytes over four) with basis
  `estimated`. A count the producer sets itself keeps its own value and basis.
- **Only the counted row takes the sources.** A later sighting of the same
  call is stamped `oxagen.llm_call_duplicate_of` and is never summed. The
  rollup joins a stamped proxy row back for the members the counted row
  lacks (`packages/telemetry/src/cost-frames.ts`).

`cost.run_totals` keeps no basis per source. A reader that needs the basis
reads it per call from `tacho_events`. Adding basis columns to
`cost.run_totals` needs a Postgres migration and is left for the change that
first reads them.

The code is `packages/tacho/src/claude-code/system-context.ts`
(`SystemContextTracker.measure` and `measureUnseen`) and, in `recorder.ts`,
`SessionRecorder.withUnseenRequestSources` and `onSessionConversation`.

## Amendment 2026-10-03: context frames from Oxagen's hook answers (#5339)

Most wrapped Claude Code runs are recorded through hooks, OpenTelemetry
(OTel), and the transcript alone. Before this change, the Cost tab read "not
recorded" for their context. The request cannot say which bytes are hook
context, but Oxagen wrote some of that context itself. The daemon knows the
text of each hook answer as the answer leaves, with no proxy.

So `context_frame_tokens` now counts the text Oxagen's hooks hand the agent
after its start:

- A later hook's `additionalContext`: a `UserPromptSubmit` answer's notice,
  operator messages, and recalled memories, and a `PostToolUse` or
  `PostToolUseFailure` answer's operator messages and resume continuation.
- A `Stop` block's reason, which the model reads as what to do next.

The text stays in the conversation, so every later call carries it again.
Each call on the session's own conversation counts the running total, as
each call counts the steering. A side call carries neither.

| Path | What the counted row carries now |
|---|---|
| Loopback model proxy (`fidelity = 'proxy'`) | the tool definition count, the steering count, the context frame count, the system context digest, and its parts |
| Loopback model proxy, on a request that declares no tools | the tool definition count (zero), the system context digest, and its parts |
| OTel `api_request` record or transcript `assistant` record, on a session the proxy did not carry | the steering count and the context frame count, on a call of the session's own conversation |
| An OTel `api_request` record of a side call, or one that names no `query_source` | nothing |
| A subagent's OTel or transcript row | nothing |

- **The start is steering's.** The `SessionStart` answer's text is the
  steering prefix and the steers delivered beside it. The `steering.manifest`
  frame counts both, so the context frame count leaves the start out and
  nothing is counted twice.
- **A count of zero is absent.** The count leaves out context a person's own
  hooks or project files add, which Oxagen never sees. So zero from Oxagen
  does not mean zero context, and a call that carries none of Oxagen's text
  has no `context_frame_tokens`. The Cost tab still reads "not recorded"
  there.
- **The basis is `estimated`.** The count is `budgetTokens` over the text,
  like every other count on this path. It is not the `apportioned` byte share
  `get_run_context` uses. A share splits the vendor's prompt total across
  the blocks by their bytes, so it needs the request's total bytes, and a session the
  proxy did not carry never has them. With only the injected text's bytes,
  any share would be the same bytes-over-four estimate under another name.
  The envelope's token source basis is `reported` or `estimated` for the same
  reason.
- **A call reads the total as of when it was made.** OTel exports in batches,
  and the transcript is read behind the session. A call's record can arrive
  after a later answer left. Each answer is kept with the time it left, and a
  call takes the total at or before its own time. The tracker keeps the last
  32 answers, which is the most a record can fall behind and still read its
  own total.
- **A compaction or a `/clear` empties the total.** A `SessionStart` whose
  source is `compact` or `clear` replaces the conversation, so the text is no
  longer sent.
- **The context frames are a count and never a part.** They ride the
  conversation, not the prefix the system context digest covers. A new recall
  does not read as a changed system context, and detector 3 is unchanged.
- **The interrupt's text is not counted.** It stands in for the refused
  tool's result, so it is a tool result.
- **Other harnesses.** Codex answers the same boundaries and its rollout rows
  take the same count. Stella hands its agent text only at the start, so it
  has no count. Cursor's model calls carry no usage record, so no row carries
  one.

**Tool definitions stay absent on a session the proxy did not carry.** No
hook payload, OTel record, or transcript record lists the tools a session
declared, so nothing can count them. Only a request carries the tool list,
and only the proxy sees the request.

**Tool result tokens are estimated where Claude Code reports none.** Claude
Code counts a result's tokens only on its OTel tool span, which a session
without enhanced telemetry never sends. The hook's `PostToolUse` row keeps
the result's size as `tool_output_bytes` under every retention, `digest_only`
included, so it needs no body. The recorder now writes `tool_result_tokens`
on that row as the size over four, rounded up, with a new
`tool_result_tokens_basis` of `estimated`. The span's count is `reported`.

- **The span wins.** The rollup and the findings job read the span's count
  when one exists and the hook's estimate when none does
  (`packages/telemetry/src/cost-frames.ts`, `RESULT_TOKENS`).
- **An estimate is never priced as reported.** A tool's sum in
  `breakdown.tools` carries `resultTokensBasis: "estimated"` when any of its
  counts was an estimate, the way one estimated part makes a cost basis
  `estimated`. The tool's cost was already labeled `estimated`. The
  `unpaged_results` finding prices an estimated result the same way and
  labels its figure `estimated`, as findings label every other estimate. It
  does not skip the result: the size is the best record of a large result on
  a session the span does not cover.
- **An old row reads as reported.** Migration
  `0038_tacho_events_tool_result_tokens_basis.sql` adds the column with an
  empty default, like the three token source bases. An empty basis beside a
  count is a row from before the column, when only the span wrote a count. A
  `DEFAULT 'reported'` would say the same of old rows, and would also stamp
  `reported` on a new row whose producer forgot its basis.
- **The estimate is of the result the hook saw.** Claude Code hands the hook
  its own result object, and the model reads that result in Claude Code's
  own wording. The two are close in size, and the basis says the count is
  not Claude Code's.

**A growing source is re-sent only as far as an earlier call carried it.**
The rollup's re-sent split (#4572) counted every call after a run's first as
re-sending its whole count. Context frames grow during a run, so each hook
answer's first send was counted as re-sent, and the `standing_context`
finding priced it. A call now re-sends a source only up to what the last call
that carried it sent, the smaller of the two counts. A call that carried none
of a source is skipped, so a side call's zero tool definitions reset nothing.
A source that holds still gives the same split as before. A compaction that
empties the context frames is not seen by the split, so the first call after
it counts up to its own count as re-sent (`createStandingSplit` in
`packages/billing/src/cost-rollup-store.ts`).

The code is `SystemContextTracker.noteInjectedContext` and `injectedAt` in
`system-context.ts`, `noteHandedContext` in
`packages/tacho/src/collector/hook-handler.ts`, the compaction reset in
`SessionRecorder.sealHookDraft`, the estimate in `claude-code/hooks.ts`, and
`withResultBasis` in `packages/billing/src/findings/unpaged-results.ts`.
