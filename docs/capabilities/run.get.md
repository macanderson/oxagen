# run.get

The Run page's header and one page of its frames (`apps/app/ARCHITECTURE.md` §1.2, §3.5). The header is the same row `list_runs` returns. Frames exist for ledger runs only: the run's V2 events, cursored on the run's own `run_seq` behind an opaque cursor this capability owns. A wrapped (tacho) run answers `frames: null`; its events live in ClickHouse `tacho_events`, which has no read seam yet.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/runs/get`
- MCP: `get_run`
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `get_run`
- Not billed (`noBillingGate: true`): an SSE poll is not a governed action (ADR-052 exclusion 2). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |
| `framesAfter` | string | no | a frame or page cursor from an earlier read; omitted reads from the start; a cursor this capability did not write is `invalid_input` |
| `frameLimit` | integer | no | 1-500, default 200 |
| `waitMs` | integer | no | 0-20000, default 0; the handler waits inside the tenant scope, re-reading the ledger every 500 ms, until an event past the cursor lands or the budget runs out |

## Output

| Field | Type | Description |
|---|---|---|
| `run` | object | the `list_runs` row for this run |
| `frames` | object or null | null for a tacho run |
| `frames.frames` | object[] | `{ cursor, seq, type, stage, observedAt, digest, summary }` |
| `frames.cursor` | string or null | the point to continue from, past every event this read consumed; null when nothing lay past `framesAfter`, so the caller keeps its cursor |

A read that starts at the page cursor or at any frame's own cursor repeats nothing and skips nothing. `summary` is a short label built from identifiers in the event's inline receipt (engine, model, capability, outcome); an encrypted payload shows the event type and nothing it cannot read.

## Errors

- `not_found` (404): the id belongs to no run in the caller's workspace, whichever store minted it. RunStore fences the org through RLS and the identity query fences the workspace as well.
- `invalid_input` (400): a cursor this capability did not write.

## Poll budget

Every invoke runs the IAM check and the audit and security emissions once, before the handler starts; the wait is inside the handler. With `waitMs: 20000` an idle Run page costs at most three invokes a minute.
