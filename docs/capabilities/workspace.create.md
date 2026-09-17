# workspace.create

**Domain:** workspace
**Mode:** sync
**Scope:** tenant (workspace is scoped under the caller's active tenant)

## Intent

Create a workspace inside the caller's active tenant. Workspaces own
their own RBAC roster, default graph, and slug; the slug is unique
within the tenant and forms the second segment of every URL
(`/:tenant_slug/:workspace_slug/...`).

## Input

| Field  | Type                     | Notes                               |
| ------ | ------------------------ | ----------------------------------- |
| `name` | `string` (1 – 120 chars) | Human-readable workspace name.      |
| `slug` | `string` (2 – 40 chars)  | Lowercase letters, digits, hyphens. |

## Output

| Field        | Type                | Notes                                |
| ------------ | ------------------- | ------------------------------------ |
| `publicId`   | `string`            | Prefixed with `wrk_` per §4.3.       |
| `name`       | `string`            | Echoes the stored name.              |
| `slug`       | `string`            | Echoes the reserved slug.            |
| `tenantSlug` | `string`            | Convenience for client-side routing. |
| `createdAt`  | `string` (ISO 8601) | Server-side creation timestamp.      |

## Side effects

- Postgres: insert `workspace.workspaces`, insert `workspace.workspace_users` (caller as owner).
- ClickHouse: emit a `workspace.created` row in `events`.
- Neo4j: upsert `(:Workspace { public_id })` and `(:Tenant)-[:OWNS]->(:Workspace)`.

## Routes and the context they carry

`POST /v1/:org/:ws/workspaces` and the org-only mount `POST /v1/:org_slug/workspaces`, added so a caller with no workspace can create their first one. `create_workspace` is scoped, so the kernel enters a tenant scope and asserts both ids are uuids. The org-only mount therefore carries `ORG_ONLY_WORKSPACE_ID` (`@oxagen/oxagen`) as its workspace id, the same constant `apps/app`'s kernel seam uses for an organization-level call; an empty string is refused with a `TenantScopeError` before the handler runs, which the API answers 400 `invalid_tenant_scope` (#3029).

## Access

Org `Owner` or `Admin`, or the `Owner` of the workspace the call is scoped to, checked in the handler (`assertOrgRole`, INV-29) for the signed-in user or, on an API-key (MCP) call, the key's creator (`resolveActingUserId`). `noBillingGate`: creating a workspace is a settings write, never a governed action (ADR-052 exclusion 2). A call with neither a signed-in user nor an API key with a live creator is refused before any read.

## Errors

| code            | reason              | meaning                                                                  |
| --------------- | ------------------- | ------------------------------------------------------------------------ |
| `forbidden`     | `no_principal`      | No signed-in user, and no API key with a live creator, on the request.   |
| `forbidden`     | `org_role_required` | The acting user holds none of the accepted roles.                        |
| `not_found`     | `org_not_found`     | The org row the context names is missing.                                |
| `conflict`      | `slug_taken`        | Slug collides within the org (pre-check, or the unique index on a race). |
| `invalid_input` | —                   | Slug fails the contract's validator (kernel).                            |

## SPEC references

- §4.2 — URL structure
- §4.4 — slug uniqueness (within tenant)
- §6.3 — `workspace` schema
