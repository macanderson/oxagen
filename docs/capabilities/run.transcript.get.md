# run.transcript.get

One run read as a transcript at one of three zoom levels (Mission Control spec §8.4, §14 "the transcript at three zoom levels (turns, steps, everything)"; ADR-058). The transcript is derived on the server from the frames and the bodies the recorder kept; nothing is stored.

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

## Chips (`kinds`)

| Chip | Frames it selects |
|---|---|
| `prompt` | the request half of a model call |
| `responses` | the response half of a model call, or a single model receipt |
| `tools` | either half of a tool call |
| `policy` | a decision a rule or a person made: allow, deny, route |
| `recall` | what was pulled into the model's context |
| `usage` | a frame that carried a cost record |
| `errors` | a call whose recorded outcome is failed, denied, cancelled, error, timeout or refused |

The filter selects frames and the fold runs over what is left, so a filtered transcript is the transcript of those frames. An empty selection keeps everything: no chip pressed is not the same as every chip pressed off.

The Mission Control mockup also draws a `thinking` chip. Neither the ledger's event vocabulary nor a wrapped session's kinds records a reasoning segment in this revision, so there is no kind for it — a chip that can only ever answer "none" would be the placeholder §3.4 forbids. It arrives with the frame type that records reasoning content, not before.

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
| `entries[].kinds` | string[] | the chips this entry answers to |
| `entries[].request` | object or null | what went out; null when the recording has only the terminal receipt |
| `entries[].response` | object or null | what came back; null when only a write-ahead intention was recorded |
| `entries[].{request,response}.seq`, `.type` | string | the frame that carried the half |
| `entries[].{request,response}.digest`, `.bytesRef` | string or null | the recorded digest, and where the bytes were retained |
| `entries[].{request,response}.redactions` | object[] | what was removed before the body was written |
| `entries[].{request,response}.fidelity` | `full` \| `digest_only` | so a `digest_only` recording says so on every half |
| `entries[].{request,response}.text` | string or null | the body as UTF-8, cut at 16 384 characters; null when no body was retained, the body is not text, the frame carried no content, or the stored bytes do not hash to the recorded digest |
| `entries[].{request,response}.truncated` | boolean | true when `text` was cut |
| `entries[].decision` | object or null | `{ seq, decision, type, at }` — the decision folded into the entry |
| `entries[].frames` | integer | frames folded, the opening frame included |
| `entries[].cost` | `{ micros, currency, basis }` or null | the folded frames' cost records summed; null when none carried one. Ledger frames carry no cost record; spend is metered per run |
| `entries[].cumulativeCost` | `{ micros, currency, basis }` or null | every cost record of the run up to and including this entry (spec §8.4 prefix sum), so a page never restates the run's spend as the page's |
| `cursor` | string or null | the point to continue from; null when nothing lies past this page |
| `complete` | boolean | false when the run has more than 10 000 frames, so the transcript is a prefix |

## Errors

- `not_found` (404): no run with that id in the caller's workspace.
- `invalid_input` (`invalid_cursor`): a cursor this capability did not write. A stale cursor is refused rather than treated as the start, which would silently restart and repeat the run.

The interface renders the recorded fidelity word and never a stronger one (spec §8.4).
