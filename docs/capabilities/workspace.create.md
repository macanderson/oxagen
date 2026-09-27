# create_workspace

Create a workspace in the caller's organization and start provisioning its steering repo (steering-repo-spec, Provisioning; lane S1, #4450).

A workspace owns its own membership roster, its default tool registry and its slug. The slug is unique within the organization and forms the second segment of every URL (`/:org_slug/:workspace_slug/...`).

Every workspace gets a private steering repo named `oxagen-<slug>` in the organization's GitHub organization or GitLab group. The handler records the workspace with its `steering_repo` setting at `provisioning`, sends the Inngest event `steering-repo/provision.requested`, and returns. A durable job then creates the repository, seeds it, applies the prescribed settings, publishes version 1 of the steering record, and binds the repository with role `steering`. The call returns before the repository exists, so read the workspace's `steering_repo` status to follow the job.

A workspace no longer takes a main repository. `mainRepo` is deprecated and ignored: the handler still accepts it so older callers keep working, logs a warning, and binds nothing. To connect a code repository, call [`link_repository`](repository.link.md) after the workspace exists.

**Surfaces:** api, mcp, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/workspaces` and the org-only mount `POST /v1/:org_slug/workspaces` → 201
- MCP: `create_workspace`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: none
- Authentication: session or API key; org Owner or Admin, or the Owner of the workspace the call is scoped to, checked by the handler (INV-29)
- Capability name: `create_workspace`
- Not billed (`noBillingGate: true`: a settings write, never a governed action, ADR-052 exclusion 2); IAM default-deny; medium sensitivity; `agent.requiresApproval: true`

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `name` | string | yes | 1 to 120 characters |
| `slug` | string | yes | the shared workspace-slug shape (`packages/oxagen/src/workspace-slug.ts`): lowercase letters, digits, hyphens; reserved org-route segments refused |
| `mainRepo` | object | no | deprecated and ignored; still validated, so a malformed value is refused as `invalid_input` |

## Output

| Field | Type | Description |
|---|---|---|
| `publicId` | string | `wrk_…` |
| `name` | string | the stored name |
| `slug` | string | the reserved slug |
| `orgSlug` | string | for client-side routing |
| `createdAt` | string | RFC 3339 |
| `steering_repo.status` | `"provisioning"` \| `"ready"` \| `"failed"` \| `"blocked"` | the steering repo's status when the call returned: `provisioning` once the job is queued, `failed` when the event could not be sent |

## Steering repo status

The workspace's `settings.steering_repo` holds the job's progress: the status, the last step that finished, the step that failed, an error code and message, the repository once it exists, and the steering binding's `rpb_…` id once it is bound.

| Status | Meaning |
|---|---|
| `provisioning` | the job is running, or queued |
| `ready` | the repository exists, version 1 is published, and the steering binding is written |
| `failed` | a step stopped, and a retry resumes from that step; `enqueue_failed` means the event was never sent |
| `blocked` | an organization owner must act first, such as authorizing Oxagen Steering again |

## Side effects

One Postgres transaction writes `workspace.workspaces` with its `steering_repo` setting, `workspace.workspace_users` (the caller as owner), the built-in agent, the default MCP registry and the default environment. After the commit, the handler sends `steering-repo/provision.requested`. When the send fails, the handler logs it, saves the setting with status `failed` and error code `enqueue_failed`, and still returns 201. A `workspace.created` security event is recorded after the commit.

## Routes and the context they carry

`create_workspace` is scoped, so the kernel enters a tenant scope and asserts both ids are uuids. The org-only mount therefore carries `ORG_ONLY_WORKSPACE_ID` (`@oxagen/oxagen`) as its workspace id, the same constant `apps/app`'s kernel seam uses for an organization-level call; an empty string is refused with a `TenantScopeError` before the handler runs, which the API answers 400 `invalid_tenant_scope` (#3029).

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal` | no signed-in user, and no API key with a live creator |
| `forbidden` | `org_role_required` | the acting user holds none of the accepted roles |
| `not_found` | `org_not_found` | the org row the context names is missing |
| `conflict` | `slug_taken` | the slug collides within the org (the pre-check, or the unique index on a race) |
| `invalid_input` | | the slug, or a deprecated `mainRepo`, fails the contract's validator (kernel) |

A failure to start the steering repo job is not a refusal. The workspace exists, and its `steering_repo` status reads `failed`.

## SPEC references

- §4.2, URL structure
- §4.4, slug uniqueness within the organization
- steering-repo-spec, Provisioning
