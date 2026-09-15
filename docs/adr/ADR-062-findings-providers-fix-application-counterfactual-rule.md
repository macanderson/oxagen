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
findings per kind are kept, largest saving first.

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
| Unpaged results (mockup) | `unpaged_results` | tool | `tool_result_tokens` above 20,000, from the OTel tool span joined on `tool_use_id` | the same result at 4,000 tokens |

The tool-call kinds price a call's `tool_result_tokens`; a hook call with no
span carrying that figure is cited and not covered.

### Waiting on a recorder

These rows have no finding in this release, and no detector writes their
kind. Each names the field no recorder in the tree writes, so there is no
cited frame to prove it or no measured cost to price. A row joins the table
above in the change that records its field.

| §12.8 row or mockup kind | Reads | What is missing |
|---|---|---|
| Refetching a stable list (mockup) | a read-only tool's identical result of the same input in an earlier run | the saving is the tool's execution, and the result tokens enter the new run's context either way; no recorder writes a per-call tool execution cost, or the size of a not-modified or diff response |
| Cache misses after a stable prefix changed | a system-context digest per turn | `tacho_events` carries `prompt_digest` for the user prompt and no digest of the system context; no ledger event records one |
| Tool-list bloat | `cost.run_totals.tool_definition_tokens` | null on every row until a recorder measures prompt composition (ADR-060) |
| Context bloat | `cost.run_totals.context_frame_tokens` and the citation rate from `context_use_feedback` | the column is null, and no recorder writes `context_use_feedback` |
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
