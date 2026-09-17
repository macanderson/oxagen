# run.transcript.get

One run read as a transcript at one of three zoom levels (Mission Control spec §14 "the transcript at three zoom levels (turns, steps, everything)"; ADR-058). The transcript is derived on the server from the frames and the bodies the recorder kept; nothing is stored.

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

## Zoom levels

- `everything`: one entry per frame.
- `steps`: one entry per model call (`model.call_completed`, `llm_call`, `model.request`, `model.response`) and per tool call (`tool.call_completed`, `tool_call`, `tool_requested`); every other frame folds into the step before it, and frames before the first step fold into a leading `frame` entry.
- `turns`: one entry per `turn_start` frame; when the recording carries no turn boundaries, one entry wherever the frames' turn index changes; a run with neither is one turn.

## Output

| Field | Type | Description |
|---|---|---|
| `zoom` | string | as asked |
| `entries` | object[] | at most 2000 |
| `entries[].seq`, `endSeq` | string | the frame that opens the entry and the last frame folded into it |
| `entries[].at` | string | RFC 3339, the opening frame's observation |
| `entries[].kind` | `turn` \| `model_call` \| `tool_call` \| `frame` | |
| `entries[].type`, `label` | string | the opening frame's recorded type and its machine-derived label |
| `entries[].text` | string or null | the opening frame's body as UTF-8, cut at 16 384 characters; null when no body was retained, the body is not text, the frame carried no content, or the stored bytes do not hash to the recorded digest |
| `entries[].truncated` | boolean | true when `text` was cut |
| `entries[].fidelity` | `full` \| `digest_only` | the opening frame's body fidelity, so a `digest_only` recording says so on every entry |
| `entries[].frames` | integer | frames folded, the opening frame included |
| `entries[].cost` | `{ micros, currency, basis }` or null | the folded frames' cost records summed (spec §8.4: cumulative cost is a prefix sum computed on read); null when none carried one. Ledger frames carry no cost record; spend is metered per run |
| `complete` | boolean | false when the run has more than 10 000 frames or more entries than the transcript can carry |

## Errors

- `not_found` (404): no run with that id in the caller's workspace.

The interface renders the recorded fidelity word and never a stronger one (spec §8.4).
