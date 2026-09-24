# list_commands

The delivery report for one run (Mission Control spec §7.4, §7.6): every command addressed to it, newest first, with its status in the closed nine-word vocabulary, the mode that was requested and the mode that was achieved, and `appliedAtSeq`, the frame that proves an `applied`. `applied` is the only success status; interfaces group `cancelled`, `expired` and `failed` as undelivered.

The status shown is the recorded one, with one derivation: a `queued` command whose expiry has passed reads `expired`, which is what the host's next poll writes under the same predicate. A command the host holds (`sent`, `received`, `acknowledged`) reads as recorded until the host reports what the boundary did — `applied` with the frame, or `expired` with `expired before a boundary` — and carries `expiresAt`, from which an interface shows it as past expiry and awaiting the host. The status shown never contradicts the run's chain and is never one the host can overturn.

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/commands/list`
- MCP: `list_commands`
- Authentication: session (org Owner, Admin, or Member; workspace Owner or Member)
- Capability name: `list_commands`
- Not billed (`noBillingGate: true`): a console read is never a governed action (ADR-052 exclusion 2). IAM default-deny; medium sensitivity.

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `runId` | string | yes | `arun_…` or `tse_…` |
| `limit` | integer | no | 1–100, default 50 |

## Output

| Field | Type | Description |
|---|---|---|
| `commands` | object[] | newest first |
| `commands[].id` | string | `tcm_…` |
| `commands[].command` | enum | the wire vocabulary: `pause`, `resume`, `cancel`, `steer`, `message`, `revoke`, `refresh_bundle`, `kill` |
| `commands[].status` | enum | `draft`, `queued`, `sent`, `received`, `acknowledged`, `applied`, `cancelled`, `expired`, `failed` |
| `commands[].requestedMode` | enum or null | `next_step`, `interrupt`, `turn_boundary`; null for a command with no prompt content |
| `commands[].deliveryMode` | enum or null | the mode achieved, at or below the requested one; null until resolved |
| `commands[].degradedReason` | string or null | why the two differ: `no_step_carrier` (the host delivers steering only at the next prompt) or `harness_tier` (nothing on the run's path can cut a call in flight) |
| `commands[].reason` | string or null | the operator's reason |
| `commands[].issuedAt`, `expiresAt`, `sentAt`, `acknowledgedAt`, `appliedAt` | RFC 3339 or null | |
| `commands[].appliedAtSeq` | integer or null | the frame sequence the effect landed on |
| `commands[].detail` | string or null | the connection point's detail on `failed`, or `superseded_by:<id>` on `cancelled` |

## Errors

- `not_found` (404): the id belongs to no run in the caller's workspace, whichever store minted it.
