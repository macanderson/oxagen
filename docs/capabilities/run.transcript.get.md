# get_run_transcript

One run read as a transcript at one of three zoom levels (Mission Control spec §8.4, §14 "the transcript at three zoom levels (turns, steps, everything)"; ADR-058). The transcript is derived on the server from the frames and the bodies the recorder kept; nothing is stored.

A wrapped run's subagents record on chains of their own. The transcript reads every chain under the run's root session and places each subagent chain directly after the `subagent_start` that spawned it. An entry from a subagent chain carries `subagent`, and its body halves and decisions carry `sessionUuid`, because a subagent chain numbers its frames from 0 like the run's. `get_run_frame_body` reads the run's own chain only.

The cursor is opaque. It names two frames: the opening of the last entry sent, and the latest frame any page has delivered. An entry whose frames grew past that second frame since it was sent (a step that gained its result, a turn that gained a step, a Task call whose subagent recorded more) is sent again once, ahead of the new entries, and no entry after it is sent again (#4048). A reader keeps each entry once by its opening frame, `seq` together with `subagent.sessionUuid`, and replaces a copy it holds with the one sent again. A cursor written before the two-frame form, which names one frame, is still accepted.

A page reads a bounded range of the run's frames rather than the run from the cursor to its end, and a subagent chain is read by its `session_uuid` from the list Postgres keeps, so a read's cost does not grow with the workspace. A whole-run reader pages at the largest `limit` the contract allows. The Cost tab's per-turn ledger is `get_run_turns`, which counts every frame of the run in one grouped read rather than paging this one (#4067).

A body the store cannot return reads as `text: null` on its half; the rest of the page is still answered.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/transcript`
- MCP: `get_run_transcript`
- CLI: none
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `get_run_transcript`
- Not billed (`noBillingGate: true`): reading a recording is a console read (ADR-052 exclusion 2). IAM default-deny; high sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |
| `zoom` | `turns` \| `steps` \| `everything` | yes | |
| `kinds` | string[] | no | the chips pressed; empty (the default) keeps every frame |
| `after` | string | no | an entry cursor from an earlier read |
| `limit` | integer | no | 1–500, default 200 |

## Zoom levels

- `everything`: one entry per frame, so the two halves of a step are two entries, each with its own body. A decision frame is its own entry, with kind `policy`.
- `steps`: one entry per model call (`model.call_completed`, `model.engine_call_started`, `model.engine_call_completed`, `llm_call`, `model.request`, `model.response`) and per tool call (`tool.call_completed`, `tool.engine_call_started`, `tool.engine_call_completed`, `tool_call`, `tool_requested`), with the request half and the response half folded into one entry; every other frame folds into the step before it, and frames before the first step fold into a leading `frame` entry.
- `turns`: one entry per `turn_start` frame; when the recording carries no turn boundaries, one entry wherever the frames' turn index changes; a run with neither is one turn.

### How the two halves pair

A step is one request and one response wherever the producer writes two — the write-ahead intention and the terminal receipt. They pair on the call id the receipt records (`tool_call_id`, `model_call_id`); a wrapped session's rows carry no call id, so its halves pair on adjacency within the step kind. A producer that appends a single terminal receipt for the whole exchange records it as the `response`, because its body is the result, and `request` is then null.

A wrapped Claude Code session writes several frames for one tool call, all carrying the call's `tool_use_id` as `callId`: Oxagen's gate decision, the hook's request, the harness's own permission check, and the receipt. They are often not adjacent. The Run page gathers every frame with the same `callId` into one step, and reads the gate's recorded `target` as the step's command when the receipt kept no body.

Claude Code's own permission check (`tool_decision` and `tool.blocked_on_user` in its OTel log) is recorded as `harness_permission`, not `policy_decision`. It runs on every call and is not a decision a rule made, so it answers to no chip. A row stored before this kind existed, as a `policy_decision` from `otel_log` or `otel_span` with `policy_source: harness`, reads as `harness_permission` too.

## Chips (`kinds`)

| Chip | Frames it selects |
|---|---|
| `prompt` | the request half of a model call, or the `turn_start` an operator typed to open a turn of a wrapped run. A subagent's `turn_start` and the `oxagen:message` copies of the same prompt are not counted, so each prompt counts once |
| `responses` | the response half of a model call, or a single model receipt |
| `thinking` | a model call whose usage records reasoning tokens. A wrapped session records them from Claude Code's `thinking_tokens`; a duplicate sighting of the same call carries no usage and is not counted |
| `tools` | either half of a tool call |
| `policy` | a decision a rule or a person made: allow, deny, route, and an operator's pause, resume, cancel or steer as the host applied it (`oxagen:command_applied`) |
| `recall` | what was pulled into the model's context |
| `usage` | a frame that carried a cost record |
| `seal` | a frame that records the chain's own integrity: a `checkpoint`, a `telemetry_gap`, or the ledger event that closes an attempt |
| `errors` | a call whose recorded outcome is failed, denied, cancelled, error, timeout, refused or rejected |

The filter selects frames and the fold runs over what is left, so a filtered transcript is the transcript of those frames. An empty selection keeps everything: no chip pressed is not the same as every chip pressed off.

The run page mockup (`mockups/pages/run.md`) draws the same chips in the order `TRANSCRIPT_KINDS` lists them. `policy` is not among the mockup's chips; it stays a kind because the Policy tab reads it, and the app files it under the tools chip. The contract has no `none` kind. The app's `kinds=none` query opens the Transcript tab with every chip off. The tab filters the whole-run read the page already made, so no chip setting reads again.

## Output

| Field | Type | Description |
|---|---|---|
| `zoom`, `kinds` | string, string[] | as asked |
| `entries` | object[] | at most 500 |
| `entries[].seq`, `endSeq` | string | the frame that opens the entry and the last frame folded into it |
| `entries[].at` | string | RFC 3339, the opening frame's observation |
| `entries[].elapsedMs` | integer | milliseconds from the run's recorded start; clamped at zero |
| `entries[].kind` | `turn` \| `model_call` \| `tool_call` \| `policy` \| `frame` | |
| `entries[].type`, `label` | string | the opening frame's recorded type and its machine-derived label |
| `entries[].callId` | string or null | the call the opening frame belongs to (`tool_call_id`, `model_call_id`, or a wrapped `toolUseId`); null when the producer recorded none. Clients that rebuild steps at `everything` pair halves on this value rather than on adjacency |
| `entries[].kinds` | string[] | the chips this entry answers to |
| `entries[].target` | string or null | what Oxagen's gate recorded the call acting on (`tool_target`: a command, a path, a pattern), cut at 400 characters; absent when the gate recorded none |
| `entries[].effort` | string or null | the reasoning effort the model call ran at (`low`, `medium`, `high`), as the harness recorded it on `tacho_events.effort`; null when none was recorded |
| `entries[].subagent` | object or absent | on an entry from a subagent chain: `{ sessionUuid, id, type }`, plus `spawnCallId`, the `tool_use_id` of the Task or Agent call that spawned it, so a client can nest the subagent's steps under that call |
| `entries[].request` | object or null | what went out; null when the recording has only the terminal receipt |
| `entries[].response` | object or null | what came back; null when only a write-ahead intention was recorded |
| `entries[].{request,response}.seq`, `.type` | string | the frame that carried the half |
| `entries[].{request,response}.digest`, `.bytesRef` | string or null | the recorded digest, and where the bytes were retained |
| `entries[].{request,response}.redactions` | object[] | what was removed before the body was written |
| `entries[].{request,response}.fidelity` | `full` \| `digest_only` | so a `digest_only` recording says so on every half |
| `entries[].{request,response}.text` | string or null | the body as UTF-8, cut at the zoom's cap (see below); null when no body was retained, the body is not text, the frame carried no content, the stored bytes do not hash to the recorded digest, or the half carries an `assembly` instead |
| `entries[].{request,response}.truncated` | boolean | true when `text` was cut |
| `entries[].{request,response}.assembly` | object or null | a recorded model stream folded into the message it was; null for every other half |
| `entries[].decision` | object or null | `{ seq, decision, type, source, at }`, the decision folded into the entry. An operator command records the command as `decision`. `source` is who decided, in the envelope's `policy_source` words: `bundle` or `kernel` for Oxagen policy, `human` for an operator, `harness` or `managed_settings` for the agent's own harness; null when the frame names none. At the `steps` and `turns` zooms an operator command is not the decision of the step it folds into, because it is about the run and not about that call |
| `entries[].frames` | integer | frames folded, the opening frame included |
| `entries[].turn` | integer or null | the turn the opening frame belongs to, 1-based, the same at every zoom and under every chip filter. A recording with `turn_start` frames counts them, and a frame before the first one is in no turn (null). A recording without them starts a new turn wherever the turn index changes, and every frame is in one. A client groups `everything` entries into turns by this value |
| `entries[].cost` | `{ micros, currency, basis }` or null | the folded frames' cost records summed; null when none carried one. Ledger frames carry no cost record; spend is metered per run |
| `entries[].cumulativeCost` | `{ micros, currency, basis }` or null | every cost record of the run up to and including this entry (spec §8.4 prefix sum), so a page never restates the run's spend as the page's |
| `cursor` | string or null | the point to continue from; null when nothing lies past this page |
| `complete` | boolean | false when the run has more than 10 000 frames, so the transcript is a prefix |

## A model stream is answered as a message, not as a stream

A streaming provider writes a model response down as a few thousand
server-sent events carrying a few characters each. Those bytes are the record
and this capability never changes them. They are also not the message: a
reader given them reads roughly six parts JSON envelope to one part text, and
a cut measured on the envelope lands inside a token.

So a half whose bytes are a recorded model stream carries `assembly` and
`text: null`. The two are alternatives, never both, and the wire bytes are not
on this page at all. `get_run_frame_body` answers them byte for byte when
somebody asks for the transport.

The fold happens once, where the frame is written, and is stored beside the
body. A frame recorded before that, or one whose stored fold this codebase has
since improved, is folded on read instead, and the answer is the same either
way.

| Field | Type | What it is |
| --- | --- | --- |
| `assembly.blocks[]` | object[] | `text`, `thinking`, `tool_use` and `tool_result` blocks in the order the provider indexed them, each with a stable `id`, its `chars`, its apportioned `tokens`, its `cost`, and `partial` when the stream ended before it closed |
| `assembly.precis` | string | the step's one line, built by template from the block kinds; pure, so the same frame gives the same line on every read, and no model wrote it |
| `assembly.stopReason` | string or null | the provider's stop reason, verbatim |
| `assembly.ttftMs`, `.durationMs` | number or null | what the producer timed; the recorded stream carries no clock |
| `assembly.tokensPerSecond` | number or null | output tokens per second of wall time; null without both figures |
| `assembly.usage` | object | `inputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `outputTokens`, each nullable, so no total hides a cache hit |
| `assembly.partial` | boolean | true when the stream ended before the message did; its blocks are still answered |
| `assembly.wire` | object | `events` and `bytes`: what the transport was, for a reader that wants to see it |

A `tool_use` block's input carries every string field up to 400 characters and
folds a longer one to `"…N characters"`, with `inputFolded: true`. A `Write`
call's content is the file, and a page of steps carrying every one of them
would be the mistake the wire was. A text or thinking block is cut on a LINE
boundary, never inside a word, and says `truncated: true`.

A block's `cost` is its apportioned share of the message's output tokens at the
model's output rate from the price book. A model the book prices no output for
leaves every block's cost null rather than drawing a zero.

## How much body text a zoom carries

`everything` is one entry per frame and carries up to **16 384** characters per half. `turns` and `steps` fold a whole exchange into one entry and carry up to **1 024** — a page of 200 steps at the full cap is several megabytes of body text nobody asked for on that render, and an excerpt plus the entry's `label` is what a folded level is for. A half cut at either cap says `truncated: true`, so a reader follows the frame to `get_run_frame_body` for the whole of it.

## Errors

- `not_found` (404): no run with that id in the caller's workspace.
- `invalid_input` (`invalid_cursor`): a cursor this capability did not write. A stale cursor is refused rather than treated as the start, which would silently restart and repeat the run.

The interface renders the recorded fidelity word and never a stronger one (spec §8.4).
