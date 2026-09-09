# set_data_plane

**Domain:** org
**Mode:** sync
**Scope:** organisation (`scoped: false` — requires an orgId, no workspace)
**Surfaces:** api, mcp
**Sensitivity:** high · **Default effect:** deny · **Roles:** org Owner, Admin
**Risk level:** high · **Requires approval:** yes · **Billing gate:** none

Contract: `packages/oxagen/src/contracts/org.data_plane.set.ts`
Handler: `packages/handlers/src/org.data_plane.set.ts`
API: `PUT /v1/:org/:workspace/org/data-plane`
MCP: `apps/mcp/src/tools/org.data_plane.set.ts`
Decision record: [ADR-042](../adr/ADR-042-tenant-data-planes.md)

## Intent

Bind one of the organisation's stores to a **dedicated**, customer-controlled
endpoint — or return it to the **shared** platform plane. This is the capability
an enterprise or regulated customer (HIPAA, data residency, air-gapped network)
uses to keep its agents' traces, ontology, and memory inside a network it
controls.

The binding is on the **organisation**, never the workspace and never the
request: the customer's firewall is an organisation property, while workspaces
are a product-level partition inside it.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| kind | `"postgres" \| "neo4j" \| "clickhouse"` | Which store to bind |
| mode | `"shared" \| "dedicated"` | `dedicated` requires `config`; `shared` forbids it |
| config | object? | Plaintext connection config, validated per kind |

Per-kind `config` shapes:

| kind | Fields |
| --- | --- |
| postgres | `host`, `port` (default 5432), `database`, `username`, `password`, `ssl` (default `true`), `maxConnections?` |
| neo4j | `uri` (`bolt://` / `neo4j://`, optionally `+s` / `+ssc`), `username`, `password`, `database` |
| clickhouse | `url` (http/https), `username`, `password`, `database` |

Two cross-field rules are enforced by the contract, not the handler, so a
malformed endpoint is rejected before any secret is written:

1. `dedicated` requires a `config`; `shared` must omit it (the platform plane's
   connection is process env, never per-organisation state).
2. The `config` must match the declared `kind` — the union would otherwise
   accept a Neo4j URI under `kind: "clickhouse"` and fail much later as an
   opaque connection error against a live customer endpoint.

TLS defaults **on** for a dedicated Postgres plane: the connection crosses a
network the platform does not control, so plaintext must be an explicit opt-out.

## Output

The same **redacted** binding `get_data_plane` returns — host, database name,
mode, status, schema version, and the verification/rotation timestamps. Setting
a plane never echoes the credential back.

## Side effects

1. **Encrypt first.** The whole config is envelope-encrypted with the
   `@oxagen/crypto` KMS envelope (the same envelope the plugin credential vault
   uses) before anything touches a column. If `AUTH_TOKEN_ENCRYPTION_KEY` is
   unset the call is **refused** — a plaintext connection string must never
   reach Postgres, not even transiently.
2. **Upsert `org.data_planes`** through `withSystemDb` (platform state on the
   shared plane). `config_digest` — a SHA-256 over the canonical plaintext
   config — is stored beside the ciphertext; it is the store clients' pool key,
   so a rotated credential misses the cache and the pool bound to the revoked
   password is closed rather than retried. `status` resets to `active`, and
   `schema_version` / `last_verified_at` reset to null: a newly bound plane is
   unverified until the health check and the per-plane migration runner run.
3. **Invalidate** the resolver cache for this (org, kind) and evict the
   organisation's dedicated pool/driver/client, so the new binding is live at
   once rather than after the short TTL.
4. **Audit** a `data_plane.updated` security event (SOC2 CC6.1/CC6.8). The row
   records that the change happened and by whom; the config never appears in it,
   in the structured log, or in any error message.

## Errors

- `AUTH_TOKEN_ENCRYPTION_KEY` unset while binding a dedicated plane — refused
  rather than stored in plaintext.
- Contract validation: config present with `mode: "shared"`, config missing with
  `mode: "dedicated"`, or a config that does not match the declared kind.

## Not in this slice

Per-plane migration runners. A dedicated Postgres plane is not automatically
brought up to the platform's Atlas schema version, and the ClickHouse/Neo4j
schema runners do not yet iterate planes (ADR-042 §3). Until that lands, a
dedicated plane must be migrated out of band; a plane whose `schema_version`
lags is marked `degraded` and its organisation's scoped writes fail closed with
`DataPlaneUnavailableError`.
