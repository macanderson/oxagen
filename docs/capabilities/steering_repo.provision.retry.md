# retry_steering_repo_provision

Re-send a failed or blocked steering repo setup so it runs again (#4750).

Before this capability, a failed or blocked setup had no button. The health banner and the
organization setting could only show the failure; getting past it needed a support ticket or
a manual database edit. Retry flips the recorded state back to `provisioning`, clears the
stored error, and re-sends the provision event with a fresh id, so the same job
(`provisionSteeringRepo`) picks the run back up from the step that failed.

**Surfaces:** api, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/repo/retry` with the body `{}`, or `{ "connection": { "provider": "github", "id": 11 } }`, returns 200
- MCP: none
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: medium`).
- CLI: none
- Authentication: org Owner or Admin, checked by the handler (INV-29)
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

| Field | Type | Description |
|---|---|---|
| `resetConnection` | boolean, optional | clear the organization's stored steering connection first, so the job lists the candidates again (#4899). Refused once Oxagen has created a steering repo in the stored account |
| `connection` | `{ provider, id }`, optional | the GitHub organization or GitLab group to create the steering repo in. After `choose_connection`, one of [get_steering_repo](steering_repo.get.md)'s `connectionChoices`. For a workspace with no repository yet, any place [list_steering_repo_destinations](steering_repo.destinations.list.md) lists |
| `name` | string, optional | a new name for a workspace's steering repo while it has no repository. The rules are `create_workspace`'s `steeringRepo.name` rules |

The org and workspace come from the capability context. A workspace-scoped context names the
workspace. An organization-only context (the sentinel workspace id) retries the organization's
own setup.

A `connection` from `connectionChoices` is stored as the organization's steering connection
before the job is sent again, so `pick_connection` finds it and goes on (#4875).

A workspace whose setup has not created its repository yet can change where the repository
goes and what it is called (#5196). A `connection` that is not one of the recorded choices
becomes the workspace's `requested_connection`, and the job's `pick_connection` checks it
against the places the stored tokens reach. A `name` becomes `requested_name`, and the job
creates exactly that name. Use these after `repository_name_taken`, `unknown_connection`, or
`repository_create_refused`.

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
| `conflict` | `unknown_connection` | for the organization's own setup, `connection` is not one of the connections the setup found. Nothing changed |
| `conflict` | `organization_repo_fixed` | `name` was sent for the organization's own setup, whose repository is always `oxagen-config`. Nothing changed |
| `conflict` | `repository_exists` | `name` or a new `connection` was sent after Oxagen created the workspace's repository. Nothing changed |
| `conflict` | `connection_in_use` | `resetConnection` was sent, and a setup of the organization has a repository in the stored account that published a version, was bound, or finished. Nothing changed |
| `conflict` | `setup_running` | `resetConnection` was sent while a setup of the organization saved as `provisioning` in the last 10 minutes, or `name` or a new `connection` was sent while this setup is not `failed` or `blocked`. Nothing changed |
| `conflict` | `connection_already_chosen` | the organization already holds a different steering connection, because another setup's pick stored it first. Retry without `connection` to use it |
