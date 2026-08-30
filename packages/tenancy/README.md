# @oxagen/tenancy

The **one identity seam** for tenant (`org`) + workspace isolation. It owns a
single `AsyncLocalStorage<TenantScope>`, so data accessors can read the active
scope instead of passing ids by hand. This package only carries the scope — the
enforcement lives next to each store. It has no runtime dependencies.

## The scope

```ts
import { runInTenantScope, getScope, requireScope } from "@oxagen/tenancy";

runInTenantScope({ orgId, workspaceId }, () => {
  // ...anything in here (and its async children) can call requireScope()
});
```

- `runInTenantScope(scope, fn)` — check the ids are uuids (anything else
  **throws**) and enter the scope. Entered once in `kernel.invoke()`, and also
  at the non-kernel entrypoints (Next server actions, Inngest steps). The
  snapshot it stores is frozen, so nothing downstream can repoint an in-flight
  request at another tenant.
- `requireScope()` — the active scope, or throw `TenantScopeError`
  (`code: "no_tenant_scope"`). Used by every data accessor. The same error and
  code also come out of `runInTenantScope` on a malformed id, so the code alone
  does not tell the two apart — read the message.
- `getScope()` — the active scope, or `null` for code that legitimately runs
  unscoped.
- `runWithPrincipal(attribution, fn)` — layer "who is acting" onto the active
  scope. The kernel calls it after the IAM check, because the principal is not
  known when the scope is first entered. Scopes are snapshots, so this enters a
  nested scope rather than editing the current one. It does nothing when no
  scope is active.
- `getPrincipalAttribution()` — the active scope's attribution, or all-null. It
  never throws: an unattributed telemetry write must not become a failed write.

Attribution is **metadata for the audit trail, never an access check.** IAM
decides who may do what; these fields only record who the decision was for.

## In tests

`@oxagen/tenancy/testing` carries fixed ids and a wrapper, so a unit test that
touches scoped code does not have to invent uuids:

```ts
import { withTestScope, TEST_ORG, TEST_WS } from "@oxagen/tenancy/testing";

withTestScope(() => {
  // runs inside { orgId: TEST_ORG, workspaceId: TEST_WS }
});
```

## Choosing a database wrapper (`@oxagen/database`)

Raw `db()` is **banned by ESLint** (`eslint.tenancy-seams.mjs`). The rule is
`no-restricted-imports`, so it catches `import { db } from "@oxagen/database"`
and nothing else — a namespace import (`import * as d` then `d.db()`) or a
local re-export slips past it. Treat the rule as a guardrail against the honest
mistake, not a boundary against a determined bypass; review still has to look.

Three `eslint.config.mjs` blocks turn the ban off, each deliberate: the
seam-owning packages (`database`, `ontology`, `telemetry`) that wrap the raw
clients; the Better Auth Drizzle adapter (`packages/auth/src/auth.ts`), which
needs a persistent handle to non-RLS tables; and `tools/scripts/**`, which runs
as a trusted operator across tenants. Every other access uses one of:

| Wrapper | When | What it does |
|---|---|---|
| `withTenantDb(fn)` | **Default.** Any code running inside a known tenant (kernel handlers; server actions / Inngest steps wrapped in `runInTenantScope`). | Opens a tx, sets `app.current_org_id` / `app.current_workspace_id` GUCs (and `app.rls_bypass` per the flag). RLS enforces. Requires an active scope. |
| `withRepeatableReadTenantDb(fn)` | **One case only:** building the admission-time authorization snapshot. | Same as `withTenantDb`, at REPEATABLE READ so the grant ceiling and its deny-generation counters share one MVCC snapshot. Can fail with a serialization error (40001) the caller must retry. Import it from `@oxagen/database/tenant` — the barrel does not re-export it. |
| `withSystemDb(fn)` | The **narrow** set of cross-/pre-scope cases (see below). | Opens a tx with `app.rls_bypass='on'`. No scope required. Audited, greppable. |

`withSystemDb` is the **explicit escape hatch** — use it only for:

- identity resolution that must read RLS-policied tables before a scope exists
  (resolve an org from a slug / api-key, membership checks);
- resolving an org from an external id on inbound webhooks (Stripe customer);
- trusted cross-tenant system / cron jobs (e.g. the nightly usage rollup);
- bootstrap that creates a tenant's own root rows (org / workspace creation);
- the security-event audit write, which must land even on a no-scope deny.

Neo4j uses `scopedSession()` (`@oxagen/ontology`); ClickHouse uses
`chInsert` / `chSelect` (`@oxagen/telemetry`). Both are also banned-raw by ESLint.

### Transaction-span guidance

`withTenantDb` / `withSystemDb` hold a Postgres transaction for the callback's
lifetime. **Do not wrap a long LLM/tool/render call in one block.** Long agent
runs use several short blocks around their DB touches only. Enforced by review.

## Enforcement

**`TENANT_RLS_ENFORCEMENT_ENABLED`** decides whether the policies actually
filter. It is **fail-closed**: when unset it is ON in production and OFF in
dev / test / preview.

- **on:** policies are load-bearing. `withTenantDb` sets `app.rls_bypass='off'`.
- **off:** `withTenantDb` sets `app.rls_bypass='on'` and the policies pass
  everything through. Isolation then rests entirely on the manual `eq(orgId)`
  predicates that every query keeps regardless. This is a local-development
  convenience, not a deployment mode — `assertRlsEnforcedInProduction()`
  (`@oxagen/database`) refuses to boot a production runtime that forces it to
  `false`.

Policy migrations are generated by `tools/scripts/gen-rls-migration.ts` from
`packages/database/src/tenant-policy.manifest.ts` into
`packages/database/atlas/migrations/`. They apply `ENABLE` + `FORCE ROW LEVEL
SECURITY` unconditionally — `FORCE` so even the table owner is subject to the
policies.

### ⚠️ The connection role MUST NOT bypass RLS

`FORCE ROW LEVEL SECURITY` does **not** cover two unconditional bypass paths:
**superusers** and roles with the **`BYPASSRLS`** attribute. If the app connects
as such a role, every policy is dead weight and isolation silently fails.

- The app (`api` / `app` / `mcp`) **must** connect as a **non-superuser,
  non-`BYPASSRLS`** role (e.g. `oxagen_app`). Migrations run as the owner role;
  `tools/scripts/provision-rls-role.ts` creates the app role.
- `assertRlsConnectionSafe()` (`@oxagen/database`) runs at each service's
  startup and **refuses to boot** when enforcement is on but the role can bypass
  RLS. While enforcement is off it only runs the production guard above.
