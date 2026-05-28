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

## Errors

| code              | meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `slug_taken`      | Slug collides within the tenant.                     |
| `invalid_slug`    | Slug fails the regex validator.                      |
| `tenant_missing`  | No active tenant on the request context.             |
| `forbidden`       | Caller lacks `workspace:create` in the tenant.       |

## SPEC references

- §4.2 — URL structure
- §4.4 — slug uniqueness (within tenant)
- §6.3 — `workspace` schema
