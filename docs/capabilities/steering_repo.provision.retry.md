# retry_steering_repo_provision

Re-send a failed or blocked steering repo setup so it runs again (#4750).

Before this capability, a failed or blocked setup had no button. The health banner and the
organization setting could only show the failure; getting past it needed a support ticket or
a manual database edit. Retry flips the recorded state back to `provisioning`, clears the
stored error, and re-sends the provision event with a fresh id, so the same job
(`provisionSteeringRepo`) picks the run back up from the step that failed.

**Surfaces:** api

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/repo/retry` with the body `{}` returns 200
- MCP: none
- Agent: none. Retry is the health banner's admin button, so the contract carries no agent metadata
- CLI: none
- Authentication: org Owner or Admin, checked by the handler (INV-29)
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

None. The org and workspace come from the capability context. A workspace-scoped context names
the workspace; an organization-only context (the sentinel workspace id) retries the
organization's own setup.

## Output

| Field | Type | Description |
|---|---|---|
| `status` | `provisioning`, `ready`, `failed`, or `blocked` | the status after the retry |

## What a retry does

1. Reads the scope's stored steering repo state. Every field the job's steps use to resume or
   skip work it already finished — the chosen candidate name, the repository it already
   created, the `attempt` counter — is left exactly as the failed run wrote it.
2. When the status is `failed` or `blocked`, sets it to `provisioning`, clears the stored error,
   and sends `steering-repo/provision.requested` with the event id
   `steering-repo-retry:<scope>:<epoch-ms>`. That id is distinct from the backfill id
   (`steering-repo-backfill:<workspaceId>`, #4683/#4751), so Inngest's 24-hour dedup window on
   the backfill id never eats a retry.
3. When the status is already `ready` or `provisioning`, sends nothing and answers the current
   status. Retry is a no-op on a setup that is not stuck.

If the send itself fails, the handler records the failure (`enqueue_failed`) and answers
`failed` rather than leaving the state stuck at `provisioning` with no job coming.

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no signed-in user; not an org Owner or Admin |
| `not_found` | `no_steering_repo_state` | the scope has no steering repository setup to retry |
