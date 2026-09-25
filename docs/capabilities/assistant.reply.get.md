# get_assistant_reply

The reply an in-app agent turn left on the record, read by the run the turn was recorded as (ADR-176).

The app streams a turn over `POST /v1/:org_slug/:workspace_slug/chat/stream`. A dropped connection does not stop the turn: it runs to completion and persists its reply as the assistant's message (ADR-092). This read is how a client that lost the stream gets the finished reply back. The stream's first event names the run, before the engine is asked anything, so a client that received any of the stream holds the id this read takes. The assistant flyout offers it as "Load the finished reply".

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/assistant/reply`
- App: the assistant flyout, after its stream drops (`features/shell/assistant-actions.ts`)
- Authentication: session or API key (an API key reads as the person who created it); org Owner or Admin, workspace Owner or Member, checked in the handler for every organization tier (INV-29). These are the roles `ask_assistant` grants.
- Capability name: `get_assistant_reply`
- Not billed (`noBillingGate: true`): reading the record is a console read (ADR-052 exclusion 2).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…`, the run the turn was recorded as. A wrapped session's `tse_…` id is refused as invalid input. |

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | the run asked about |
| `runStatus` | enum | the run's status on the ledger: `pending`, `running`, `completed`, `failed` or `cancelled` |
| `reply` | object or null | `{ conversationId, text }`: the reply persisted for the run in one of the caller's own conversations, and the conversation it continues. Null while none is recorded. |

What a null `reply` means depends on `runStatus`:

- `pending` or `running`: the turn has not ended. Ask again later.
- `completed`: the reply is still being written. The ledger seals the run just before the reply is saved, so this lasts a moment.
- `failed` or `cancelled`: the turn ended without a reply, and none will be written. The run records why.

## Errors

| Code | Status | When |
|---|---|---|
| `not_found` (reason `run_not_found`) | 404 | no run with that id in this workspace, or the run is not an in-app agent turn |
| `forbidden` (reason `no_principal`, `org_role_required`) | 403 | the caller carries no person, or the person holds none of the contract's roles |

A reply belongs to the person whose conversation it is. Another member of the workspace reads `reply: null` for it, beside the run's status, which `get_run` already shows them.
