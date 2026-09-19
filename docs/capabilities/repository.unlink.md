# unlink_repository

Remove a linked repository from the workspace (MC spec §10.1; the §17 M0 acceptance test "a second repo can be linked and unlinked"; ADR-099).

The repository is addressed by the `rpb_…` binding id `list_repositories` and `link_repository` answer. The handler deletes the repository's binding head, the mutable pointer that says "this workspace sees this repository", and leaves every binding version in place: `ingestion.repository_bindings` is immutable evidence that runs admitted against it still cite. Linking the repository again writes a successor version, not a second version 1.

The main repository is never removed by this write. A workspace without a main repository cannot exist (§10.1), so a main head refuses with `conflict: main_repo_unlink_refused`. Changing which repository is main is an org-owner action recorded as a security event, and it has no capability yet.

**Surfaces:** api, mcp, cli

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/repository/unlink` → 200
- MCP: `unlink_repository`, on an API-key context whose key has a live creator (`resolveActingUserId`)
- CLI: `oxagen repo unlink <bindingId> [--json]`
- Authentication: session or API key; org Owner or Admin, or the workspace's Owner, checked by the handler (INV-29)
- Capability name: `unlink_repository`
- Not billed (`noBillingGate: true`); IAM default-deny; medium sensitivity

## Input

| Field | Type | Required | Constraint |
|---|---|---|---|
| `bindingId` | string | yes | `rpb_…`, the binding version the head currently points at |

## Output

| Field | Type | Description |
|---|---|---|
| `bindingId` | string | the id that was given |
| `fullName` | string | `owner/name` of the repository that was unlinked |
| `unlinkedAt` | string | RFC 3339 |

## Refusals

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required` | no acting user; not an org Owner or Admin or the workspace's Owner |
| `not_found` | `repository_not_linked` | no head in this workspace points at that binding id |
| `conflict` | `main_repo_unlink_refused` | the head is the workspace's main repository |

The read that finds the head is bounded twice, by row-level security and by explicit org and workspace predicates, so a binding id from another workspace is `not_found` and never a hint that the id exists elsewhere. The write runs under the same transaction-scoped advisory lock `bind_main_repository` and `link_repository` take, so each writer reads the heads the previous one committed.

## What this write does not do

Nothing is purged from the graph. The v2 descriptor at `packages/oxagen/src/contracts/v2/unlink-repository.ts` carries the purge-and-deregister target shape until its cutover; ADR-099 records the deferral.
