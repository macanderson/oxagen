# get_data_plane

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Risk level:** high · **Requires approval:** yes · **Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.data_plane.get.ts`
Handler: `packages/handlers/src/org.data_plane.get.ts`
API: `GET /v1/:org/:workspace/org/data-plane?kind=<kind>`
MCP: `apps/mcp/src/tools/org.data_plane.get.ts`
Decision record: [ADR-042](../adr/ADR-042-tenant-data-planes.md)

## Intent

Answer "where does this organisation's data for one store physically live, and
is that plane healthy?" A **data plane** is an organisation-level binding of one
store — Postgres, Neo4j, or ClickHouse — to either the **shared** platform plane
or a **dedicated**, customer-controlled endpoint inside the customer's network.
Absence of a binding row means the shared plane, so this capability always
returns an answer, never a 404.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| kind | `"postgres" \| "neo4j" \| "clickhouse"` | Which store's binding to read |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| kind | enum | Echoes the requested store |
| mode | `"shared" \| "dedicated"` | Shared = the platform plane |
| status | `"active" \| "degraded" \| "disabled"` | Only `active` admits traffic |
| host | string \| null | Endpoint host of a dedicated plane; `null` for shared |
| database | string \| null | Database / graph name; `null` for shared |
| schemaVersion | string \| null | Applied schema version of a dedicated plane |
| lastVerifiedAt | ISO-8601 \| null | Last successful health verification |
| rotatedAt | ISO-8601 \| null | Last credential rotation |

**The raw DSN is never returned.** ADR-042 §4 makes this a hard rule: no
password, no username, no port, no full URI. A read that echoed the credential
would turn every org-admin token into a copy of the customer's database
password, and there is deliberately no read-back path — an operator who needs to
change a credential calls `set_data_plane` with a new one.

`host` and `database` are `null` for a shared plane on purpose: the platform's
own endpoint is process env, not the organisation's business, and returning it
would leak infrastructure topology to every org admin.

## Side effects

None. Reads `org.data_planes` through `withSystemDb` (the binding table is
platform state that always lives on the shared plane — see ADR-042 §2), filtered
to the caller's org. The KMS envelope is opened only for a `dedicated` row, and
only to recover the host and database name.

## Errors

- `data_plane_unavailable` is **not** raised by this capability — a degraded or
  disabled plane is exactly what an operator calls this to see. That error comes
  from the store clients (`withTenantDb`, `scopedSession`, `chInsert`/`chSelect`)
  when the organisation's scoped data access is refused.
- A `dedicated` row whose envelope cannot be opened (missing
  `AUTH_TOKEN_ENCRYPTION_KEY`, corrupt ciphertext) fails the read rather than
  falling back to reporting the shared plane.
