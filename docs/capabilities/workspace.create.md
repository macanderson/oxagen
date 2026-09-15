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

| Field  | Type                     | Notes                                |
| ------ | ------------------------ | ------------------------------------ |
| `name` | `string` (1 – 120 chars) | Human-readable workspace name.       |
| `slug` | `string` (2 – 40 chars)  | Lowercase letters, digits, hyphens.  |

## Output

| Field         | Type                | Notes                                  |
| ------------- | ------------------- | -------------------------------------- |
| `publicId`    | `string`            | Prefixed with `wrk_` per §4.3.         |
| `name`        | `string`            | Echoes the stored name.                |
| `slug`        | `string`            | Echoes the reserved slug.              |
| `tenantSlug`  | `string`            | Convenience for client-side routing.   |
| `createdAt`   | `string` (ISO 8601) | Server-side creation timestamp.        |

## Side effects

- Postgres: insert `workspace.workspaces`, insert `workspace.workspace_users` (caller as owner).
- ClickHouse: emit a `workspace.created` row in `events`.
- Neo4j: upsert `(:Workspace { public_id })` and `(:Tenant)-[:OWNS]->(:Workspace)`.

## Access

Org `Owner` or `Admin`, or the `Owner` of the workspace the call is scoped to, checked in the handler (`assertOrgRole`, INV-29). `noBillingGate`: creating a workspace is a settings write, never a governed action (ADR-052 exclusion 2). A context with no signed-in user is refused before any read.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | The user holds none of the accepted roles. |
| `not_found` | `org_not_found` | The org row the context names is missing. |
| `conflict` | `slug_taken` | Slug collides within the org (pre-check, or the unique index on a race). |
| `invalid_input` | — | Slug fails the contract's validator (kernel). |

## SPEC references

- §4.2 — URL structure
- §4.4 — slug uniqueness (within tenant)
- §6.3 — `workspace` schema
