# rename_sandbox

**Domain:** agent
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Set the human-friendly **display label** on a durable sandbox session so a
person can tell warm sandboxes apart in the list (`start_sandbox` sets the
initial label; this renames it later). The label is display-only: it never
affects reuse (that is keyed by `sessionKey`) and never touches the running
container.

The write merges `label` into the session's metadata JSON (`jsonb ||` concat),
so the frozen session spec living in the same blob — `memoryMb`,
`secretSelection`, `environmentId`, `repos`, … — is preserved, not overwritten.
There is no driver round-trip.

## Input

| Field       | Type     | Default  | Notes                                                             |
| ----------- | -------- | -------- | ----------------------------------------------------------------- |
| `sessionId` | `string` | required | Durable-session id (`sbx_…`) returned by `agent.sandbox.start`.   |
| `label`     | `string` | required | New display name, 1–80 characters (trimmed). Empty/whitespace-only is rejected. |

## Output

| Field       | Type     | Notes                                        |
| ----------- | -------- | -------------------------------------------- |
| `sessionId` | `string` | The renamed session's opaque id (`sbx_…`).   |
| `label`     | `string` | The label now stored on the session.         |

## Surfaces

- **API:** `POST /v1/:org/:workspace/agent/sandbox/rename` — body `{ sessionId, label }`
- **MCP:** `rename_sandbox` tool (not read-only, non-destructive, idempotent)
- **Agent:** invoked via `invoke("rename_sandbox", ...)` — no approval required

## API

```
POST /v1/{org}/{workspace}/agent/sandbox/rename
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "label": "acme-api refactor"
}
```

Response:

```json
{
  "sessionId": "sbx_01abc...",
  "label": "acme-api refactor"
}
```

## Access control

- Caller must be an authenticated workspace member.
- Only sessions in the caller's workspace can be renamed (org + workspace scoped).
- Default effect: **deny** — explicit role grant required (Org Owner/Admin,
  Workspace Owner/Member allowed by default).

## Side effects

- Merges `{ label }` into the session's metadata jsonb and bumps `updated_at`.
- No driver interaction; the sandbox container is untouched.

## Errors

| code                       | meaning                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `validation_error`         | Input failed Zod parse (empty label, label > 80 chars).            |
| `sandbox_session_not_found`| No live session with that id in the caller's workspace (or it was stopped). |
