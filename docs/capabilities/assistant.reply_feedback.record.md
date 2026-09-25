# record_reply_feedback

**Capability name:** `record_reply_feedback`
**Domain:** assistant
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low

Record a person's verdict on one reply of the in-app assistant: `useful` or `wrong`, with an optional short note. The verdict lands against the run the reply was recorded as, so the replay set can find the turns people marked wrong (#4169).

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/assistant/feedback`
- MCP: `record_reply_feedback`
- App: the two controls under each answered reply in the assistant flyout (`apps/app/src/features/shell/assistant-reply-feedback.tsx`)
- Authentication: session or API key. An API key votes as the person who created it.
- Roles: `ask_assistant`'s, org Owner or Admin, workspace Owner or Member, checked in the handler for every organization tier (INV-29). The people who may ask may rate what they were told.
- Not on the `agent` surface. The verdict is the person's judgment of the assistant. A tool the model could call would let it grade its own replies, and a label the graded party writes is not evidence.
- Billed: no. A verdict acts on no agent and spends nothing, so it is not a governed action (`noBillingGate: true`, ADR-052 exclusion 2).

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `conversationId` | uuid | yes | the conversation the reply sits in, as `ask_assistant` returned it |
| `runId` | string | yes | `arun_...`, the run the reply was recorded as, as `ask_assistant` returned it |
| `verdict` | `useful` or `wrong` | yes | |
| `note` | string or null | no | trimmed, then 1 to 500 characters. Null or absent for none |

The note cap is 500 characters: two or three sentences naming the run, the number, or the step the reply got wrong. The row is append-only and kept until its TTL, so the cap also stops one request from writing any amount of text into a table nobody trims.

## Output

| Field | Type | Description |
|---|---|---|
| `runId` | string | the run the verdict was recorded against |
| `conversationId` | uuid | the conversation that holds the reply |
| `messageId` | uuid | the assistant message the run wrote, resolved by the handler |
| `verdict` | string | `useful` or `wrong` |
| `note` | string or null | the note as stored, or null |
| `recordedAt` | string | RFC 3339, the row's `created_at` |

## What the handler checks

Before it writes, the handler reads Postgres in the caller's organization and workspace:

1. `agent.agent_runs` holds the run on an in-app surface (`chat` or `api-chat`).
2. `chat.conversations` holds the conversation, owned by the caller and not deleted.
3. `chat.messages` holds the assistant message in that conversation whose `metadata.runId` is the run.

Any of the three missing is one `not_found`, so the answer never says whether a run exists in another person's conversation.

## Recording

One row in ClickHouse `assistant_reply_feedback` (migration `0030_assistant_reply_feedback.sql`): `org_id`, `workspace_id`, `run_public_id`, `conversation_id`, `message_id`, `user_id`, `verdict`, `note`, `created_at`. Rows are never updated or deleted before the 365-day TTL. A person who changes their mind votes again, which writes a second row.

A reader takes the newest vote per person and run. `readReplyFeedback` in `@oxagen/telemetry` does that with `argMax(..., created_at)` and filters on the current verdict and on named runs. The replay set reads `readReplyFeedback({ verdict: "wrong", windowDays, limit })` inside the workspace's tenant scope, then opens each run through `get_run`.

## Errors

| Code | Status | When |
|---|---|---|
| `invalid_input` | 400 | the note is over 500 characters or blank, the verdict is neither value, or an id is malformed |
| `forbidden` (reason `no_principal`, `org_role_required`) | 403 | the caller carries no person, or the person holds none of the contract's roles |
| `not_found` (reason `assistant_reply_not_found`) | 404 | the run is not an assistant run in this workspace, the conversation is not the caller's, or it holds no reply recorded as the run |
