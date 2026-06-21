# Tenant + Workspace Isolation (Row-Level Security) — SPEC

> Status: proposed · Owner: Mac Anderson · Tracking: **OXA-1515** (parent)
> Supersedes the interim comment in `apps/app/src/app/api/v1/chat/stream/route.ts:167`.

## 1. Purpose

Make tenant (`org`) and workspace isolation a **property of the platform, not of
each query**. Today every read/write must remember to add
`eq(table.orgId, ctx.orgId)` (Postgres), `WHERE node.orgId = $orgId` (Neo4j), and
`WHERE org_id = {orgId}` (ClickHouse). One forgotten predicate is a cross-tenant
data leak — a SOC 2 / GDPR / HIPAA reportable event. We replace "remember the
filter" with "the store refuses to return another tenant's rows," enforced in
**one place per store** and driven from **one identity seam**.

Hard requirement from the user: a developer writing a normal handler must **not
have to think about tenant/workspace filters** for correctness, and this must
**not** create per-tenant DB users, a heavy repository layer, or unit-test hell.

## 2. Goals / Non-goals

**Goals**

- G1. A query with a *missing* tenant predicate returns **zero** cross-tenant
  rows in Postgres — enforced by the database, not the caller.
- G2. Neo4j and ClickHouse access is impossible without an active tenant scope;
  scope is injected automatically at the single client seam.
- G3. One identity seam (`CapabilityContext` → `AsyncLocalStorage`) feeds all
  three stores. Set once at the boundary; never threaded by hand.
- G4. **Fail closed.** No active scope ⇒ access denied, not "all rows." Fixes the
  MCP session-token `orgId: ""` open path (`apps/mcp/src/context.ts:105`).
- G5. Unit tests stay fast and mock-based and **do not change shape**. Isolation
  is *proven* once in a dedicated integration suite, not re-asserted per test.

**Non-goals (explicitly rejected to avoid over-engineering)**

- N1. **No per-tenant Postgres roles / users.** One app role (`oxagen`) + session
  GUCs + `FORCE ROW LEVEL SECURITY`. (Per-tenant roles = connection-pool
  explosion + migration/test hell.)
- N2. **No per-tenant Neo4j database** and **no per-tenant ClickHouse user.**
  Single shared DB, property-scoped at the seam. (Neo4j is BYO + non-load-bearing
  per the four-store law; a hard DB boundary there is unwarranted complexity.)
- N3. **No repository/DAO layer** and no ORM-middleware magic proxy. Keep the
  existing `db()` / `session()` / `clickhouse()` call style; add thin wrappers.
- N4. No change to the `id` (uuid) + `public_id` convention, the `org_id` /
  `workspace_id` column names, or `orgScopeMixin`.
- N5. Not switching to Neon's JWT/`authenticated`-role RLS — that is vendor
  lock-in (interim Neon → target AlloyDB). We use **portable, plain-Postgres**
  GUC-based RLS that runs identically on Neon, AlloyDB, and a local container.

## 3. Current state (verified)

| Store | Single seam | Scope columns | Enforcement today |
|---|---|---|---|
| Postgres (Drizzle, Neon→AlloyDB) | `packages/database/src/client.ts` `db()` | `orgScopeMixin` → `org_id`, `workspace_id` on every owned table | **None.** Manual `eq(orgId)` per query. OXA-1515 open. |
| Neo4j | `packages/ontology/src/client.ts` `session()` | node props `orgId`, `workspaceId` (2 query files) | Manual `WHERE` in Cypher. Single shared `neo4j` DB. Dead `tenantId` indexes. |
| ClickHouse | `packages/telemetry/src/clickhouse.ts` `clickhouse()` | `org_id` (lead ORDER BY), `workspace_id` | Manual `WHERE org_id = {…}`. App-enforced. |

- **Identity carrier:** `CapabilityContext { orgId, workspaceId, userId, apiKeyId,
  requestId, surface, messageId }` (`packages/oxagen/src/types.ts:151`).
- **The chokepoint:** `kernel.invoke(name, input, ctx)`
  (`packages/oxagen/src/kernel.ts:231`) — every api/mcp/app/runner capability
  passes through it; the handler runs at line 380.
- **Tests:** Vitest; every suite mocks `@oxagen/database`, `@oxagen/telemetry`,
  `@oxagen/ontology` at the module boundary. No shared test-utils package. CI runs
  real PG/CH/Neo4j containers but unit tests don't connect; E2E uses live Docker.
- **Known gaps to fix in this work:** (a) Neo4j schema drift — indexes on
  `tenantId` but runtime uses `orgId` (`packages/ontology/src/schema.cypher:36`);
  (b) MCP session tokens leave `orgId: ""` (fail-open).

## 4. Design overview — one seam, three enforcers

```
            ┌─────────────────────────────────────────────┐
 request →  │  CapabilityContext { orgId, workspaceId }    │   (resolved at the
            └───────────────────────┬─────────────────────┘    transport edge today)
                                    │
                    kernel.invoke() │  runInTenantScope(scope, () => handler(...))
                                    ▼
                 ┌──────────  @oxagen/tenancy  ──────────┐
                 │  AsyncLocalStorage<TenantScope>        │   ← the ONE identity seam
                 │  getScope() / requireScope()           │
                 └───┬───────────────┬───────────────┬────┘
                     ▼               ▼               ▼
        withTenantDb(fn)      scopedSession()   chSelect / chInsert
        (SET LOCAL GUC          (binds $orgId/    (injects org_id /
         in one tx; RLS          $workspaceId;     workspace_id predicate
         enforces at DB)         guards Cypher)    + stamps on write)
                     │               │               │
              Postgres RLS      Neo4j (prop)     ClickHouse (prop
              = HARD wall       = seam wall      + optional ROW POLICY)
```

Two layers, by design:

1. **Propagation (one seam):** `@oxagen/tenancy` owns a single
   `AsyncLocalStorage<TenantScope>`. `runInTenantScope` is entered **once** inside
   `kernel.invoke()` (and at the handful of non-kernel entrypoints: server
   actions, Inngest functions). Every data accessor reads the scope from ALS —
   ids are never passed by hand again.

2. **Enforcement (one per store):**
   - **Postgres = the hard wall.** `ENABLE` + **`FORCE ROW LEVEL SECURITY`** with
     one policy template on every `orgScopeMixin` table, keyed on session GUCs
     `app.current_org_id` / `app.current_workspace_id`. Even a query with no
     `WHERE` returns only the active tenant's rows. This is the G1 guarantee.
   - **Neo4j = seam wall.** No native RLS, but only one `session()` seam and two
     query sites. `scopedSession()` auto-binds `$orgId`/`$workspaceId` and a
     runtime guard rejects any Cypher over the seam that doesn't reference both.
   - **ClickHouse = seam wall (+ optional defense-in-depth).** `chSelect`/
     `chInsert` inject the `org_id`/`workspace_id` predicate and stamp columns
     from ALS. Optional ClickHouse `ROW POLICY` as belt-and-suspenders (phase 4).

The manual `eq(orgId)` predicates already in handlers **stay** during rollout as
redundant defense-in-depth and as planner hints; they become non-load-bearing
once RLS is forced (§8 contract phase).

## 5. The one package — `@oxagen/tenancy`

New, tiny, dependency-light package (no DB/Neo4j/CH imports — those wrappers live
next to each client so the package stays a pure seam).

```ts
// packages/tenancy/src/scope.ts
export interface TenantScope {
  readonly orgId: string;       // uuid, non-empty
  readonly workspaceId: string; // uuid, non-empty
}

const als = new AsyncLocalStorage<TenantScope>();

/** Validate + enter scope. Fail-closed: empty ids throw (fixes MCP orgId:""). */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  assertUuid(scope.orgId, "orgId");
  assertUuid(scope.workspaceId, "workspaceId");
  return als.run(scope, fn);
}

/** Current scope or null (for code that legitimately runs unscoped, e.g. cron bootstrap). */
export function getScope(): TenantScope | null {
  return als.getStore() ?? null;
}

/** Current scope or throw — used by every data accessor. */
export function requireScope(): TenantScope {
  const s = als.getStore();
  if (!s) throw new TenantScopeError("No active tenant scope — call out of bounds");
  return s;
}
```

`TenantScopeError extends Error` with a stable `code: "no_tenant_scope"` so
surfaces map it to a 403 and the audit emitter records it.

### Why ALS and not "thread ctx everywhere"

`ctx` is already threaded to handlers, but **not** down into `db()` / `session()`
calls (those take no ctx today). Threading ctx into every data accessor signature
is the change we are trying to avoid. ALS lets the accessor read scope without a
signature change — the callsite becomes `withTenantDb(tx => …)` with no ids. This
is the minimum-surface way to hit G3.

## 6. Postgres — the hard wall (the centerpiece)

### 6.1 Mechanism: GUC + FORCE RLS, one app role

- Keep the single `oxagen` role. The app role **owns** the tables, and table
  owners bypass RLS — so we use **`FORCE ROW LEVEL SECURITY`**, which subjects the
  owner to policies too. This is what removes the need for a separate restricted
  role (N1).
- Per-request the app sets two transaction-local GUCs and runs queries in that
  transaction; the policy reads them with `current_setting(..., true)`.
- `SET LOCAL` requires a transaction, and Neon/AlloyDB poolers run in transaction
  pooling — so the wrapper opens **one transaction**, sets the GUCs, runs the
  callback's queries on that `tx`, commits. Lowest-common-denominator, portable.

### 6.1a Enforcement flag (decided — mirrors `IAM_ENFORCEMENT_ENABLED`)

RLS ships **enabled at the DB but bypassable via a server-set GUC**, so the
hard cutover is an **env var flip**, not a migration — and it is reversible
without a migration (the IAM-flag pattern, zero lockout risk).

- Env var: **`TENANT_RLS_ENFORCEMENT_ENABLED`** (default `false` during seeding).
- `withTenantDb` always sets the two scope GUCs. When the flag is **off** it
  *additionally* sets `app.rls_bypass = 'on'` (a trusted, server-only GUC). When
  **on**, it does not set bypass, so the policies enforce.
- Every policy is bypass-aware:
  `USING ( current_setting('app.rls_bypass', true) = 'on' OR <scope predicate> )`.
- During the seeding window (flag off) isolation is still enforced by the manual
  `eq(orgId)` predicates that we keep permanently (§8). Exposure is therefore
  never worse than today; flipping the flag makes RLS load-bearing too. Flip is
  reversible by redeploying with the flag off — no migration needed.

### 6.2 The wrapper (the only new Postgres call style)

```ts
// packages/database/src/tenant.ts
import { sql } from "drizzle-orm";
import { db, type Database } from "./client";
import { requireScope } from "@oxagen/tenancy";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Run DB work in a tenant-scoped transaction. RLS enforces isolation. */
export async function withTenantDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { orgId, workspaceId } = requireScope();
  return db().transaction(async (tx) => {
    // set_config(key, value, is_local=true) — scoped to this tx only.
    await tx.execute(
      sql`select set_config('app.current_org_id', ${orgId}, true),
                 set_config('app.current_workspace_id', ${workspaceId}, true)`,
    );
    return fn(tx);
  });
}
```

Handler migration is mechanical and greppable: `db().query.x…` →
`withTenantDb(tx => tx.query.x…)`. No ids in the callsite.

> **Transaction-span guidance:** `withTenantDb` holds a PG transaction for its
> body. Keep DB work inside it focused; do **not** wrap a long LLM/tool call in
> one `withTenantDb`. Long agent runs use several short `withTenantDb` blocks
> around their DB touches. (Documented in the package README; enforced by review,
> not lint.)

### 6.3 The policy template (generated, one migration)

For **every** table built with `orgScopeMixin` (enumerated from the schema, ~30
tables across `agent/workflow/event/execution/chat/content/integration` + the
inline ones in `workspace/iam/billing/security`):

```sql
ALTER TABLE agent.agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.agents FORCE  ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON agent.agents
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id       = nullif(current_setting('app.current_org_id',       true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id       = nullif(current_setting('app.current_org_id',       true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );
```

The `app.rls_bypass = 'on'` disjunct is the enforcement flag (§6.1a): set
server-side by `withTenantDb` only when `TENANT_RLS_ENFORCEMENT_ENABLED=false`.

- `nullif(current_setting(..., true), '')::uuid` → when the GUC is unset/empty the
  expression is `NULL`; `col = NULL` is `NULL` → row excluded. **Fail closed** for
  reads *and* `WITH CHECK` for writes (can't insert into another tenant).
- `current_setting(..., true)` (the `true` = "missing_ok") never raises on unset.
- The constant-per-statement GUC makes `col = <param>` index-friendly, so the
  existing `(org_id, …)` indexes are used; no planner regression.

**Scope variants (handled by the generator, not by hand):**

| Table class | Policy predicate |
|---|---|
| Standard owned (`orgScopeMixin`) | `org_id = GUC.org AND workspace_id = GUC.ws` |
| Workspace-nullable (`iam.principals`, `iam.principalRoleAssignments`, `security.security_events`) | `org_id = GUC.org AND (workspace_id IS NULL OR workspace_id = GUC.ws)` |
| Org-only (`billing.*`, `org.roles/grants/policies/...`) | `org_id = GUC.org` (no workspace clause) |
| Global identity (`auth.users/sessions/accounts/verifications`) | **No policy / RLS off** — Better Auth-managed, not tenant-scoped. Access is gated by membership checks, not RLS. |
| Append-only audit in PG (if any) | `org_id = GUC.org`, `USING` only (no `WITH CHECK` beyond org), insert-only |

A small typed manifest (`tenant-policy.manifest.ts`) lists each table → class. The
migration generator reads it so a new `orgScopeMixin` table is a one-line manifest
add + regenerate, and a CI test asserts **every** `orgScopeMixin` table appears in
the manifest (no silent gaps).

### 6.4 Migration safety (expand-then-contract, §policy 5)

RLS is additive to data but behaviorally breaking if a path forgets the GUC.
Three migrations, three deploys:

1. **Expand:** ship `@oxagen/tenancy` + `withTenantDb`; migrate all call sites to
   set the GUC. **No RLS yet.** Add telemetry counter `db.query.unscoped` (logs
   when a query runs with no GUC) to prove 100% coverage in staging.
2. **Enforce:** `ENABLE` + `FORCE` RLS + policies. Now unscoped queries return
   empty (fail closed). Manual `eq(orgId)` predicates remain (harmless).
3. **Flip:** set `TENANT_RLS_ENFORCEMENT_ENABLED=true` per environment once
   phase-1 telemetry shows zero unscoped queries. Reversible via env (§6.1a).

> **Decided:** the manual `eq(orgId)` predicates are **kept permanently** as
> belt-and-suspenders and planner hints — there is no "drop the predicates"
> contract phase. They cost nothing and document intent.

Each migration is one logical change, forward-only, reversible in intent
(`DROP POLICY` / `NO FORCE` / `DISABLE`), tested in CI against a fresh DB and a
seeded snapshot.

## 7. Neo4j and ClickHouse — seam walls

### 7.1 Neo4j

Only one seam (`session()`) and two query files, so a wrapper is sufficient and
cheap. No per-tenant database (N2).

```ts
// packages/ontology/src/tenant.ts
import { session } from "./client";
import { requireScope } from "@oxagen/tenancy";

const SCOPE_GUARD = /node\.orgId|m\.orgId|\$orgId/; // must reference scope

/** A session whose run() auto-injects $orgId/$workspaceId and guards the query. */
export function scopedSession() {
  const { orgId, workspaceId } = requireScope();
  const s = session();
  return {
    run(cypher: string, params: Record<string, unknown> = {}) {
      if (!SCOPE_GUARD.test(cypher)) {
        throw new TenantScopeError(`Cypher over scoped session must filter by $orgId: ${cypher.slice(0,80)}`);
      }
      return s.run(cypher, { ...params, orgId, workspaceId });
    },
    close: () => s.close(),
  };
}
```

- The two existing queries already filter by `$orgId`/`$workspaceId`; they switch
  from `session()` to `scopedSession()` and drop the manual param pass-through.
- A unit test asserts the guard throws on un-scoped Cypher and that
  `MERGE`/vector-recall queries keep `orgId` in the MERGE key.
- **Fix the drift bug in the same PR:** rename `schema.cypher` indexes from
  `(n.tenantId)` → `(n.orgId)` so the scoped reads are actually indexed.
- **Raw-`session()` ban:** an ESLint `no-restricted-imports` rule (or a grep
  guard test) forbids importing `session` outside `packages/ontology` and the
  scoped wrapper, so new graph code can't bypass the seam.

### 7.2 ClickHouse

Append-only; scope is org-led in the sort key already. Wrap the two operations:

```ts
// packages/telemetry/src/tenant.ts
export async function chInsert(table: string, rows: object[]) {
  const { orgId, workspaceId } = requireScope();
  const stamped = rows.map(r => ({ org_id: orgId, workspace_id: workspaceId, ...r }));
  return clickhouse().insert({ table, values: stamped, format: "JSONEachRow" });
}

export async function chSelect<T>(q: { query: string; params?: Record<string, unknown> }) {
  const { orgId, workspaceId } = requireScope();
  // Caller writes "... WHERE org_id = {orgId:UUID} AND ..."; we bind the values.
  return clickhouse().query({ query: q.query, query_params: { ...q.params, orgId, workspaceId }, format: "JSON" }) as Promise<T>;
}
```

- Reads must include `org_id = {orgId:UUID}`; a guard mirrors the Neo4j one.
- **Decided: no ClickHouse `ROW POLICY`.** Seam-enforcement is sufficient because
  CH is never a source of truth (four-store law). We do not add per-tenant CH
  users or row policies — that complexity isn't warranted.

## 8. Identity propagation — wiring the seam

Set scope at exactly the boundaries that originate a request; everything
downstream inherits via ALS.

1. **Kernel (covers api/mcp/app/runner capability calls).** In
   `kernel.invoke()`, wrap the handler call (line 380):
   ```ts
   output = await runInTenantScope(
     { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
     () => handler(inputResult.data, ctx),
   );
   ```
   `runInTenantScope` throws on empty ids → **the MCP `orgId: ""` path now fails
   closed** with `no_tenant_scope`, surfaced through the existing
   `emitSecurityEvent` deny path. This is the single highest-leverage line in the
   change: ~all capability traffic is covered here.
2. **Next.js server actions** (`apps/app/.../actions.ts`) that call `db()` outside
   a capability: wrap their body in `runInTenantScope(scope, …)` using the
   already-resolved `resolveOrg()/resolveWorkspace()` values.
3. **Inngest functions** (`packages/inngest-functions`): wrap the step body in
   `runInTenantScope` using the `orgId`/`workspaceId` carried on the event
   payload. (These already filter manually today; they switch to `withTenantDb`.)
4. **Edge `proxy.ts`:** unchanged — it does cookies/redirects only, never touches
   a store, so it needs no scope (and ALS isn't edge-safe anyway).

## 9. Testing strategy — how we avoid "unit-test hell"

This is a first-class design constraint, not an afterthought.

### 9.1 Unit tests do not change shape

- `runInTenantScope` is the **only** thing a handler unit test adds, and only when
  the handler reads scope. Provide a one-liner test helper:
  ```ts
  // packages/tenancy/src/testing.ts
  export const withTestScope = (fn: () => unknown, scope = TEST_SCOPE) =>
    runInTenantScope(scope, fn);
  export const TEST_SCOPE = { orgId: TEST_ORG, workspaceId: TEST_WS };
  ```
- `withTenantDb` in unit tests: `@oxagen/database` is already `vi.mock`-ed. The
  mock's `withTenantDb` is a **pass-through** — `(fn) => fn(fakeTx)` — so existing
  mock-based tests keep asserting "the right ids/params flow into the query" with
  zero new ceremony. No transaction, no real DB, no GUC. The mock lives in the
  package's mock module so every suite gets it for free.
- Same for `scopedSession` / `chInsert` mocks: pass-through that records the
  cypher/rows. Existing assertions ("query contains `orgId`") keep working.

Net: the ~124 existing test files need **no structural change**; at most they wrap
a handler call in `withTestScope` when the handler now requires a scope.

### 9.2 Isolation is proven ONCE (solve once → test once)

One new integration suite — `packages/database/integration/rls.test.ts` — is the
single source of truth that RLS actually isolates. It runs against the **real CI
Postgres container** (already present in `ci.yml`) under a new gated job
`test:integration`:

- Seed two orgs (A, B) × two workspaces each, a few rows per table class.
- For each table class, assert:
  - With GUC = A: a **deliberately unfiltered** `select * from <table>` returns
    only A's rows (the G1 proof — no `WHERE` in the test query).
  - Insert with GUC = A and `org_id = B` → rejected by `WITH CHECK`.
  - With **no GUC set** → zero rows (fail-closed).
  - Workspace-nullable / org-only variants honor their relaxed predicate.
- ~one parametrized test over the policy manifest, not one-per-table by hand.

This is the "solve all RLS problems in one place" promise extended to tests: the
guarantee is asserted in a single suite, so the other 124 suites never re-litigate
isolation and stay pure/fast.

### 9.3 Seam guards (cheap unit tests, no DB)

- `runInTenantScope` rejects empty/invalid uuids (fail-closed) — unit test.
- `scopedSession`/`chSelect` throw on un-scoped Cypher/SQL — unit test.
- A repo-grep guard test: no `import { session }` / `db()` / `clickhouse()`
  outside the allowed seam files (prevents bypass regressions).

### 9.4 CI

- New `test:integration` job depends on the PG service container, runs migrations,
  runs `rls.test.ts`. Gated on `pull_request` only (per the CI-gate-on-PRs rule),
  not on direct main pushes.
- Unit/e2e gates unchanged.

## 10. Compliance & security notes (SOC 2 / GDPR / HIPAA)

- Isolation moves from "every developer remembers" to "the database enforces" —
  an auditable, demonstrable control (point to the policy migration + the
  `rls.test.ts` proof + the fail-closed kernel line).
- Fail-closed everywhere: unset scope = deny, not leak. The kernel deny is already
  written to the ClickHouse audit chain via `emitSecurityEvent`.
- No secrets/roles per tenant to manage, rotate, or leak (N1).
- Encryption-at-rest unchanged (Neon/AlloyDB managed) — orthogonal to this work.

## 11. File-by-file change list

**New**
- `packages/tenancy/` — `scope.ts`, `errors.ts`, `testing.ts`, `index.ts`,
  `package.json`, `vitest.config.ts`, `scope.test.ts`.
- `packages/database/src/tenant.ts` — `withTenantDb` + mock module.
- `packages/database/src/tenant-policy.manifest.ts` — table → policy class.
- `packages/database/drizzle/00NN_rls_enable.sql` — generated policies (enforce).
- `packages/database/integration/rls.test.ts` — the one isolation proof.
- `packages/ontology/src/tenant.ts` — `scopedSession` + guard.
- `packages/telemetry/src/tenant.ts` — `chInsert` / `chSelect` + guard.
- `tools/scripts/gen-rls-migration.ts` — manifest → SQL generator + drift test.

**Modified**
- `packages/oxagen/src/kernel.ts:380` — wrap handler in `runInTenantScope`.
- `apps/mcp/src/context.ts` — stop emitting `orgId: ""`; rely on fail-closed (or
  reject at the edge with a clear 403).
- `packages/ontology/src/schema.cypher:36-40` — `tenantId` → `orgId` indexes.
- `packages/agent/src/memory/neo4j.ts` — `session()` → `scopedSession()`.
- Handlers/actions/inngest touching `db()` — `db()` → `withTenantDb(tx => …)`;
  this is the bulk of the mechanical diff (greppable, package-by-package).
- `.github/workflows/ci.yml` — add `test:integration` job.
- ESLint config — `no-restricted-imports` for raw seam clients.

## 12. Rollout (maps to Linear sub-issues)

| Phase | Work | Gate |
|---|---|---|
| 0 | `@oxagen/tenancy` + mocks + kernel wiring + seam guards | unit green |
| 1 (expand) | `withTenantDb` + migrate all `db()` call sites; `unscoped` telemetry | staging shows 0 unscoped |
| 2 | Neo4j `scopedSession` + index drift fix; ClickHouse `chInsert`/`chSelect` | unit green |
| 3 (enforce) | RLS `ENABLE`+`FORCE`+bypass-aware policies migration; `rls.test.ts` integration job | integration green in CI |
| 4 (flip) | Set `TENANT_RLS_ENFORCEMENT_ENABLED=true` per env after telemetry is clean | 0 unscoped in prod telemetry |

## 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A code path forgets the GUC → returns empty in prod (looks like data loss) | Phase-1 `unscoped` telemetry proves coverage before enforce; fail-closed is the *safe* failure (no leak); seam guards + ESLint prevent bypass. |
| `withTenantDb` transaction held across a long LLM call → pool starvation | README guidance + review: short DB blocks only; long runs use multiple blocks. |
| Pooler (transaction mode) drops a session-level setting | We use `SET LOCAL` inside the same tx as the queries — pooler-safe by construction. |
| New `orgScopeMixin` table added without a policy | Manifest + CI drift test fails the PR if a scoped table has no policy entry. |
| Owner bypass of RLS | `FORCE ROW LEVEL SECURITY` on every policied table. |
| Neo4j seam bypassed by new raw `session()` use | ESLint `no-restricted-imports` + grep guard test. |

## 14. Rollback

- Postgres: `ALTER TABLE … NO FORCE / DISABLE ROW LEVEL SECURITY; DROP POLICY …`
  (forward migration). Manual `eq(orgId)` predicates were retained, so disabling
  RLS reverts to today's enforcement with no data exposure window.
- Tenancy seam: `runInTenantScope` becomes a pass-through if reverted; accessors
  fall back to current behavior. No schema/data rollback needed.

## 15. Decisions (resolved 2026-06-02)

1. **Enforcement flag — DECIDED: yes.** RLS ships behind
   `TENANT_RLS_ENFORCEMENT_ENABLED`, mirroring `IAM_ENFORCEMENT_ENABLED`. The flag
   drives a server-set `app.rls_bypass` GUC honored by every policy (§6.1a), so the
   cutover is an env flip and is reversible without a migration. Zero lockout risk.
2. **ClickHouse `ROW POLICY` — DECIDED: skip.** Seam-enforcement only; CH is never
   a source of truth. No per-tenant CH users or row policies (§7.2).
3. **Manual `eq(orgId)` predicates — DECIDED: keep permanently.** Belt-and-
   suspenders + planner hints; no contract phase that removes them (§8).

## 16. Implementation notes (deltas resolved during build)

Corrections and additions made while implementing this spec — each preserves the
design intent (one seam, three enforcers, fail-closed):

1. **`withSystemDb` — explicit RLS-bypass wrapper (new).** `FORCE ROW LEVEL
   SECURITY` is applied unconditionally by the migration, so a raw `db()` call
   (no GUC) returns zero rows / rejects inserts on policied tables **regardless**
   of the enforcement flag. The plan's "keep identity-resolution/cron code on raw
   `db()`" would therefore break auth (api-key/membership resolution), Stripe
   webhooks, the usage-rollup cron, and the no-scope audit write the moment the
   migration lands. `withSystemDb` (sets `app.rls_bypass='on'`, no scope required)
   is the audited, greppable escape hatch for those legitimately cross-/pre-scope
   operations. Raw `db()` is now ESLint-banned everywhere except the Better Auth
   adapter, so all access is either `withTenantDb` (scoped) or `withSystemDb`
   (bypass) — no fragile per-callsite allowlist.

2. **`workspace_only` policy class (new).** `workspace.workspace_users` carries
   `workspace_id` + `user_id` but **no `org_id`**, so the org-keyed classes can't
   cover it. Without a policy it had NO RLS → membership rows leak across tenants.
   Added a `workspace_only` class keyed on `app.current_workspace_id`. The manifest
   coverage test now also asserts every `workspace_id`-only table is covered.

3. **Superuser/`BYPASSRLS` connection guard (new).** `FORCE` does not subject
   superusers or `BYPASSRLS` roles to policies — if the app connects as one, RLS
   silently does nothing. The app must connect as a non-superuser role (e.g.
   `oxagen_app`); migrations run as the owner. `assertRlsConnectionSafe()` is
   called at `api`/`app`/`mcp` startup and refuses to boot when enforcing while
   the role can bypass RLS. The integration suite drops to a non-superuser role
   via `SET LOCAL ROLE` so policies are actually exercised in CI.

4. **Manifest schema corrections.** IAM tables live in the **`org`** Postgres
   schema (not `iam.*`). Added `content.generated_assets`, `billing.org_billing_*`,
   `billing.billing_disputes`, `org.invitations`; removed entries lacking `org_id`
   (`billing.stripe_event_processing`). 55 tables total.

5. **`.tsx` Server Components covered.** The Postgres callsite sweep also covers
   `apps/app` RSC pages/layouts (`.tsx`), which read tenant data and were migrated
   to `runInTenantScope` + `withTenantDb` (workspace routes use the real
   `{orgId, workspaceId}`; org-only routes use a neutral sentinel workspaceId).

6. **MCP `orgId:""` fix.** Session-token auth that produced an empty org is
   removed; MCP session tokens are rejected at the edge with `invalid_token`
   (API-key auth carries the real org/workspace scope).
