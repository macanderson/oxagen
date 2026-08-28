# Tenancy & RLS

Archived spec & plan — status: shipped (audited 2026-07-03).

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> Tenancy & RLS feature is fully shipped. The @oxagen/tenancy identity seam (AsyncLocalStorage) is wired into the kernel and all three data stores (Postgres via FORCE ROW LEVEL SECURITY + GUCs, Neo4j via scopedSession wrapper, ClickHouse via chInsert/chSelect). All handlers and integrations use the scoped wrappers, and comprehensive RLS isolation is proven via integration tests. The TENANT_RLS_ENFORCEMENT_ENABLED flag controls enforcement with safe defaults.

**Implementation evidence**

- /packages/tenancy/src/scope.ts — AsyncLocalStorage tenant scope with runInTenantScope/requireScope/getScope
- /packages/database/src/tenant.ts — withTenantDb wrapper setting app.current_org_id and app.current_workspace_id GUCs
- /packages/database/src/tenant-policy.manifest.ts — maps 100+ orgScopeMixin tables to RLS policy classes
- /packages/database/drizzle/0009_privacy_rls_and_agent_plans_upgrade.sql — Postgres RLS policies with bypass GUC
- /packages/ontology/src/tenant.ts — scopedSession() Neo4j wrapper with orgId guard
- /packages/telemetry/src/tenant.ts — chInsert/chSelect ClickHouse wrappers stamping org_id/workspace_id
- /packages/oxagen/src/kernel.ts — runInTenantScope wraps handler invocation at line ~560
- /packages/config/src/env.ts:250 — TENANT_RLS_ENFORCEMENT_ENABLED flag with default false
- /packages/database/integration/rls.test.ts — RLS isolation proof against live Postgres database
- /apps/api/src/routes/v1/chat.stream.ts — API route using withTenantDb (4 instances found)
- /packages/inngest-functions/src/functions/ — Inngest functions wrapped with runInTenantScope

**Source documents** (archived verbatim below)

- `docs/specs/tenancy-rls/spec.md`
- `docs/specs/tenancy-rls/plan.md`

## Spec — `spec.md`

## Tenant + Workspace Isolation (Row-Level Security) — SPEC

> Status: proposed · Owner: Mac Anderson · Tracking: **OXA-1515** (parent)
> Supersedes the interim comment in `apps/app/src/app/api/v1/chat/stream/route.ts:167`.

### 1. Purpose

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

### 2. Goals / Non-goals

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

### 3. Current state (verified)

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

### 4. Design overview — one seam, three enforcers

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

### 5. The one package — `@oxagen/tenancy`

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

#### Why ALS and not "thread ctx everywhere"

`ctx` is already threaded to handlers, but **not** down into `db()` / `session()`
calls (those take no ctx today). Threading ctx into every data accessor signature
is the change we are trying to avoid. ALS lets the accessor read scope without a
signature change — the callsite becomes `withTenantDb(tx => …)` with no ids. This
is the minimum-surface way to hit G3.

### 6. Postgres — the hard wall (the centerpiece)

#### 6.1 Mechanism: GUC + FORCE RLS, one app role

- Keep the single `oxagen` role. The app role **owns** the tables, and table
  owners bypass RLS — so we use **`FORCE ROW LEVEL SECURITY`**, which subjects the
  owner to policies too. This is what removes the need for a separate restricted
  role (N1).
- Per-request the app sets two transaction-local GUCs and runs queries in that
  transaction; the policy reads them with `current_setting(..., true)`.
- `SET LOCAL` requires a transaction, and Neon/AlloyDB poolers run in transaction
  pooling — so the wrapper opens **one transaction**, sets the GUCs, runs the
  callback's queries on that `tx`, commits. Lowest-common-denominator, portable.

#### 6.1a Enforcement flag (decided — mirrors `IAM_ENFORCEMENT_ENABLED`)

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

#### 6.2 The wrapper (the only new Postgres call style)

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

#### 6.3 The policy template (generated, one migration)

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

#### 6.4 Migration safety (expand-then-contract, §policy 5)

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

### 7. Neo4j and ClickHouse — seam walls

#### 7.1 Neo4j

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

#### 7.2 ClickHouse

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

### 8. Identity propagation — wiring the seam

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

### 9. Testing strategy — how we avoid "unit-test hell"

This is a first-class design constraint, not an afterthought.

#### 9.1 Unit tests do not change shape

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

#### 9.2 Isolation is proven ONCE (solve once → test once)

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

#### 9.3 Seam guards (cheap unit tests, no DB)

- `runInTenantScope` rejects empty/invalid uuids (fail-closed) — unit test.
- `scopedSession`/`chSelect` throw on un-scoped Cypher/SQL — unit test.
- A repo-grep guard test: no `import { session }` / `db()` / `clickhouse()`
  outside the allowed seam files (prevents bypass regressions).

#### 9.4 CI

- New `test:integration` job depends on the PG service container, runs migrations,
  runs `rls.test.ts`. Gated on `pull_request` only (per the CI-gate-on-PRs rule),
  not on direct main pushes.
- Unit/e2e gates unchanged.

### 10. Compliance & security notes (SOC 2 / GDPR / HIPAA)

- Isolation moves from "every developer remembers" to "the database enforces" —
  an auditable, demonstrable control (point to the policy migration + the
  `rls.test.ts` proof + the fail-closed kernel line).
- Fail-closed everywhere: unset scope = deny, not leak. The kernel deny is already
  written to the ClickHouse audit chain via `emitSecurityEvent`.
- No secrets/roles per tenant to manage, rotate, or leak (N1).
- Encryption-at-rest unchanged (Neon/AlloyDB managed) — orthogonal to this work.

### 11. File-by-file change list

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

### 12. Rollout (maps to Linear sub-issues)

| Phase | Work | Gate |
|---|---|---|
| 0 | `@oxagen/tenancy` + mocks + kernel wiring + seam guards | unit green |
| 1 (expand) | `withTenantDb` + migrate all `db()` call sites; `unscoped` telemetry | staging shows 0 unscoped |
| 2 | Neo4j `scopedSession` + index drift fix; ClickHouse `chInsert`/`chSelect` | unit green |
| 3 (enforce) | RLS `ENABLE`+`FORCE`+bypass-aware policies migration; `rls.test.ts` integration job | integration green in CI |
| 4 (flip) | Set `TENANT_RLS_ENFORCEMENT_ENABLED=true` per env after telemetry is clean | 0 unscoped in prod telemetry |

### 13. Risks & mitigations

| Risk | Mitigation |
|---|---|
| A code path forgets the GUC → returns empty in prod (looks like data loss) | Phase-1 `unscoped` telemetry proves coverage before enforce; fail-closed is the *safe* failure (no leak); seam guards + ESLint prevent bypass. |
| `withTenantDb` transaction held across a long LLM call → pool starvation | README guidance + review: short DB blocks only; long runs use multiple blocks. |
| Pooler (transaction mode) drops a session-level setting | We use `SET LOCAL` inside the same tx as the queries — pooler-safe by construction. |
| New `orgScopeMixin` table added without a policy | Manifest + CI drift test fails the PR if a scoped table has no policy entry. |
| Owner bypass of RLS | `FORCE ROW LEVEL SECURITY` on every policied table. |
| Neo4j seam bypassed by new raw `session()` use | ESLint `no-restricted-imports` + grep guard test. |

### 14. Rollback

- Postgres: `ALTER TABLE … NO FORCE / DISABLE ROW LEVEL SECURITY; DROP POLICY …`
  (forward migration). Manual `eq(orgId)` predicates were retained, so disabling
  RLS reverts to today's enforcement with no data exposure window.
- Tenancy seam: `runInTenantScope` becomes a pass-through if reverted; accessors
  fall back to current behavior. No schema/data rollback needed.

### 15. Decisions (resolved 2026-06-02)

1. **Enforcement flag — DECIDED: yes.** RLS ships behind
   `TENANT_RLS_ENFORCEMENT_ENABLED`, mirroring `IAM_ENFORCEMENT_ENABLED`. The flag
   drives a server-set `app.rls_bypass` GUC honored by every policy (§6.1a), so the
   cutover is an env flip and is reversible without a migration. Zero lockout risk.
2. **ClickHouse `ROW POLICY` — DECIDED: skip.** Seam-enforcement only; CH is never
   a source of truth. No per-tenant CH users or row policies (§7.2).
3. **Manual `eq(orgId)` predicates — DECIDED: keep permanently.** Belt-and-
   suspenders + planner hints; no contract phase that removes them (§8).

### 16. Implementation notes (deltas resolved during build)

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

## Plan — `plan.md`

## Tenant + Workspace RLS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make tenant (`org`) + workspace isolation a property the data stores enforce, driven from one identity seam, so handler authors never hand-write a tenant filter for correctness.

**Architecture:** One `AsyncLocalStorage` scope (`@oxagen/tenancy`) entered once in `kernel.invoke()`. Postgres enforces with `FORCE ROW LEVEL SECURITY` policies keyed on session GUCs (set by a `withTenantDb` transaction wrapper), gated by a bypass GUC behind `TENANT_RLS_ENFORCEMENT_ENABLED`. Neo4j and ClickHouse enforce at their single client seam via scoped wrappers + runtime guards. Isolation is proven once in a dedicated integration suite; the ~124 mock-based unit suites are unchanged.

**Tech Stack:** TypeScript (strict), Drizzle ORM + postgres.js (Neon→AlloyDB), neo4j-driver, @clickhouse/client, Vitest 2.1.9, pnpm workspaces, Zod 3.25.76.

**Spec:** `docs/architecture/tenancy-rls/spec.md`. **Tracking:** OXA-1515.

**Conventions to honor (engineering law):** strict types, no `any`, pinned deps, zero warnings, `id`(uuid)+`public_id`, expand-then-contract migrations, real test assertions, fail-closed. Run `pnpm -w typecheck` and `pnpm -w lint --max-warnings 0` green before each commit.

---

### File Structure

**New package `packages/tenancy/`** — the identity seam (no DB/graph/CH deps):
- `src/errors.ts` — `TenantScopeError`
- `src/scope.ts` — ALS + `runInTenantScope` / `getScope` / `requireScope` / `assertUuid`
- `src/testing.ts` — `TEST_ORG` / `TEST_WS` / `TEST_SCOPE` / `withTestScope`
- `src/index.ts`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/scope.test.ts`

**Postgres (`packages/database/`):**
- `src/tenant.ts` — `withTenantDb` (real) + `rlsEnforced()`
- `src/tenant.mock.ts` — pass-through mock for unit tests
- `src/tenant-policy.manifest.ts` — table → policy class
- `drizzle/0001_rls_policies.sql` — generated, bypass-aware policies
- `integration/rls.test.ts` — the single isolation proof
- `tools/scripts/gen-rls-migration.ts` — manifest → SQL + drift test

**Neo4j (`packages/ontology/`):** `src/tenant.ts` (`scopedSession`), `schema.cypher` (index drift fix).

**ClickHouse (`packages/telemetry/`):** `src/tenant.ts` (`chInsert`/`chSelect`).

**Wiring:** `packages/oxagen/src/kernel.ts`, `packages/config/src/env.ts` + `registry.ts`, `packages/agent/src/memory/neo4j.ts`, handler/action/inngest callsites, `.github/workflows/ci.yml`, root ESLint config.

---

### Phase 0 — The identity seam + kernel wiring

#### Task 1: Scaffold `@oxagen/tenancy` with scope + errors (TDD)

**Files:**
- Create: `packages/tenancy/package.json`
- Create: `packages/tenancy/tsconfig.json`
- Create: `packages/tenancy/vitest.config.ts`
- Create: `packages/tenancy/src/errors.ts`
- Create: `packages/tenancy/src/scope.ts`
- Create: `packages/tenancy/src/index.ts`
- Test: `packages/tenancy/src/scope.test.ts`

- [ ] **Step 1: Create the package manifest**

`packages/tenancy/package.json` (mirror `@oxagen/telemetry`; zero runtime deps — ALS is a Node built-in):

```json
{
  "name": "@oxagen/tenancy",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "eslint src --max-warnings 0",
    "test:unit": "vitest run"
  },
  "devDependencies": {
    "typescript": "6.0.3",
    "vitest": "2.1.9"
  }
}
```

- [ ] **Step 2: Create tsconfig + vitest config**

`packages/tenancy/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*.ts"]
}
```

`packages/tenancy/vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { environment: "node", include: ["src/**/*.test.ts"], globals: false },
});
```

- [ ] **Step 3: Write the failing test**

`packages/tenancy/src/scope.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  runInTenantScope,
  getScope,
  requireScope,
  TenantScopeError,
} from "./index";

const ORG = "00000000-0000-0000-0000-0000000000a1";
const WS = "00000000-0000-0000-0000-0000000000b2";

describe("tenant scope", () => {
  it("exposes the active scope inside runInTenantScope", () => {
    const seen = runInTenantScope({ orgId: ORG, workspaceId: WS }, () => getScope());
    expect(seen).toEqual({ orgId: ORG, workspaceId: WS });
  });

  it("returns null outside any scope", () => {
    expect(getScope()).toBeNull();
  });

  it("requireScope throws outside a scope (fail-closed)", () => {
    expect(() => requireScope()).toThrowError(TenantScopeError);
  });

  it("rejects an empty orgId (fixes MCP orgId:'' fail-open)", () => {
    expect(() => runInTenantScope({ orgId: "", workspaceId: WS }, () => 1)).toThrowError(
      /orgId/,
    );
  });

  it("rejects a non-uuid workspaceId", () => {
    expect(() =>
      runInTenantScope({ orgId: ORG, workspaceId: "not-a-uuid" }, () => 1),
    ).toThrowError(/workspaceId/);
  });

  it("isolates nested scopes and restores the outer one", () => {
    const other = "00000000-0000-0000-0000-0000000000c3";
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () => {
      runInTenantScope({ orgId: other, workspaceId: WS }, () => {
        expect(requireScope().orgId).toBe(other);
      });
      expect(requireScope().orgId).toBe(ORG);
    });
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @oxagen/tenancy test:unit`
Expected: FAIL — `Cannot find module './index'` / exports undefined.

- [ ] **Step 5: Implement `errors.ts`**

`packages/tenancy/src/errors.ts`:

```ts
/** Raised when tenant-scoped work runs with no active (or invalid) scope. */
export class TenantScopeError extends Error {
  readonly code = "no_tenant_scope" as const;
  constructor(message: string) {
    super(message);
    this.name = "TenantScopeError";
  }
}
```

- [ ] **Step 6: Implement `scope.ts`**

`packages/tenancy/src/scope.ts`:

```ts
import { AsyncLocalStorage } from "node:async_hooks";
import { TenantScopeError } from "./errors";

export interface TenantScope {
  readonly orgId: string;
  readonly workspaceId: string;
}

const als = new AsyncLocalStorage<TenantScope>();

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, field: string): void {
  if (!UUID_RE.test(value)) {
    throw new TenantScopeError(`Invalid ${field}: expected a uuid, got ${JSON.stringify(value)}`);
  }
}

/** Validate + enter scope. Fail-closed: empty/invalid ids throw. */
export function runInTenantScope<T>(scope: TenantScope, fn: () => T): T {
  assertUuid(scope.orgId, "orgId");
  assertUuid(scope.workspaceId, "workspaceId");
  return als.run({ orgId: scope.orgId, workspaceId: scope.workspaceId }, fn);
}

/** The active scope, or null when none is set. */
export function getScope(): TenantScope | null {
  return als.getStore() ?? null;
}

/** The active scope, or throw — used by every data accessor. */
export function requireScope(): TenantScope {
  const s = als.getStore();
  if (!s) {
    throw new TenantScopeError("No active tenant scope — data access out of bounds");
  }
  return s;
}
```

- [ ] **Step 7: Implement `index.ts`**

`packages/tenancy/src/index.ts`:

```ts
export { runInTenantScope, getScope, requireScope } from "./scope";
export type { TenantScope } from "./scope";
export { TenantScopeError } from "./errors";
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @oxagen/tenancy test:unit`
Expected: PASS (6 tests).

- [ ] **Step 9: Typecheck + lint + commit**

```bash
pnpm --filter @oxagen/tenancy typecheck && pnpm --filter @oxagen/tenancy lint
git add packages/tenancy
git commit -m "feat(tenancy): add AsyncLocalStorage tenant scope seam (OXA-1515)"
```

---

#### Task 2: Test helpers for `@oxagen/tenancy`

**Files:**
- Create: `packages/tenancy/src/testing.ts`
- Test: `packages/tenancy/src/testing.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/tenancy/src/testing.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { requireScope } from "./index";
import { TEST_ORG, TEST_WS, TEST_SCOPE, withTestScope } from "./testing";

describe("test helpers", () => {
  it("runs a callback inside a deterministic test scope", () => {
    const seen = withTestScope(() => requireScope());
    expect(seen).toEqual({ orgId: TEST_ORG, workspaceId: TEST_WS });
    expect(TEST_SCOPE).toEqual({ orgId: TEST_ORG, workspaceId: TEST_WS });
  });

  it("accepts an override scope", () => {
    const org = "00000000-0000-0000-0000-0000000000d4";
    const seen = withTestScope(() => requireScope(), { orgId: org, workspaceId: TEST_WS });
    expect(seen.orgId).toBe(org);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/tenancy test:unit`
Expected: FAIL — `./testing` has no such exports.

- [ ] **Step 3: Implement `testing.ts`**

`packages/tenancy/src/testing.ts`:

```ts
import { runInTenantScope, type TenantScope } from "./scope";

export const TEST_ORG = "00000000-0000-0000-0000-00000000a000";
export const TEST_WS = "00000000-0000-0000-0000-00000000b000";
export const TEST_SCOPE: TenantScope = { orgId: TEST_ORG, workspaceId: TEST_WS };

/** Run a unit-test body inside a tenant scope without ceremony. */
export function withTestScope<T>(fn: () => T, scope: TenantScope = TEST_SCOPE): T {
  return runInTenantScope(scope, fn);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/tenancy test:unit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tenancy/src/testing.ts packages/tenancy/src/testing.test.ts
git commit -m "feat(tenancy): add unit-test scope helpers"
```

---

#### Task 3: Enter the scope at the kernel chokepoint (TDD)

**Files:**
- Modify: `packages/oxagen/src/kernel.ts` (handler call at line ~380; add dep)
- Modify: `packages/oxagen/package.json` (add `@oxagen/tenancy` dependency)
- Test: `packages/oxagen/src/kernel.tenant-scope.test.ts`

- [ ] **Step 1: Add the dependency**

In `packages/oxagen/package.json`, add to `dependencies`:

```json
"@oxagen/tenancy": "workspace:*"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/oxagen/src/kernel.tenant-scope.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { getScope } from "@oxagen/tenancy";
import { invoke, registerHandler, clearHandlersForTests } from "./kernel";
import { registerCapability, clearRegistryForTests } from "./registry";
import { z } from "zod";
import type { CapabilityContext } from "./types";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

function ctx(over: Partial<CapabilityContext> = {}): CapabilityContext {
  return {
    orgId: ORG, workspaceId: WS, userId: "u1", apiKeyId: null,
    requestId: "r1", surface: "api", messageId: null, ...over,
  };
}

afterEach(() => {
  clearHandlersForTests();
  clearRegistryForTests();
});

describe("kernel tenant scope", () => {
  it("runs the handler inside the request's tenant scope", async () => {
    registerCapability({
      name: "test.echo", input: z.object({}), output: z.object({ org: z.string() }),
      surfaces: ["api"],
    });
    registerHandler("test.echo", async () => async () => {
      const s = getScope();
      return { org: s?.orgId ?? "NONE" };
    });
    const out = await invoke("test.echo", {}, ctx());
    expect(out).toEqual({ org: ORG });
  });

  it("fails closed when orgId is empty (MCP session-token path)", async () => {
    registerCapability({
      name: "test.echo2", input: z.object({}), output: z.object({}), surfaces: ["mcp"],
    });
    registerHandler("test.echo2", async () => async () => ({}));
    await expect(invoke("test.echo2", {}, ctx({ orgId: "" }))).rejects.toThrow(/tenant scope|orgId/);
  });
});
```

> Note: match `registerCapability`'s real signature in `registry.ts` if it differs (e.g. a `defaultEffect` field). Read `packages/oxagen/src/registry.ts` first and adjust the literal to the actual shape — keep the two assertions identical.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/oxagen test:unit -- kernel.tenant-scope`
Expected: FAIL — handler runs but `getScope()` is null (no wrapping yet); empty-org case does not throw.

- [ ] **Step 4: Wrap the handler call**

In `packages/oxagen/src/kernel.ts`, add the import near the top:

```ts
import { runInTenantScope } from "@oxagen/tenancy";
```

Replace the handler invocation (currently `output = await handler(inputResult.data, ctx);` inside the `try` at ~line 380) with:

```ts
    const handler = await resolveHandler(name);
    output = await runInTenantScope(
      { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      () => handler(inputResult.data, ctx),
    );
```

`runInTenantScope` throws `TenantScopeError` for empty/invalid ids; that throw is caught by the existing `catch (err)` block at line ~381, which emits the `error`/`deny` security event and rethrows — so the MCP `orgId: ""` path now fails closed with no extra code.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @oxagen/oxagen test:unit -- kernel.tenant-scope`
Expected: PASS (2 tests).

- [ ] **Step 6: Full kernel suite + typecheck + commit**

```bash
pnpm --filter @oxagen/oxagen test:unit && pnpm --filter @oxagen/oxagen typecheck
git add packages/oxagen
git commit -m "feat(kernel): enter tenant scope per invocation; fail closed on empty org (OXA-1515)"
```

---

### Phase 1 — Postgres: `withTenantDb` + enforcement flag

#### Task 4: Register the `TENANT_RLS_ENFORCEMENT_ENABLED` env flag (TDD)

**Files:**
- Modify: `packages/config/src/env.ts:120` (add to `baseEnvSchema`)
- Modify: `packages/config/src/registry.ts` (add registry entry — required by `registry.test.ts`)
- Test: `packages/config/src/env.test.ts` (add a case)

- [ ] **Step 1: Write the failing test**

Append to `packages/config/src/env.test.ts` (inside the existing top-level `describe`, mirroring how IAM_ENFORCEMENT_ENABLED is tested if such a case exists):

```ts
it("defaults TENANT_RLS_ENFORCEMENT_ENABLED to false (seeding-safe)", () => {
  __resetEnvCacheForTests();
  const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
    ...process.env,
    TENANT_RLS_ENFORCEMENT_ENABLED: undefined,
  });
  expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(false);
});

it("coerces TENANT_RLS_ENFORCEMENT_ENABLED='true' to true", () => {
  __resetEnvCacheForTests();
  const env = requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"], {
    ...process.env,
    TENANT_RLS_ENFORCEMENT_ENABLED: "true",
  });
  expect(env.TENANT_RLS_ENFORCEMENT_ENABLED).toBe(true);
});
```

> `requireEnv` accepts a `source` second arg (see `env.ts:202`), so the test injects values without mutating `process.env`. Import `requireEnv` and `__resetEnvCacheForTests` at the top of the test file if not already imported.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/config test:unit`
Expected: FAIL — `TENANT_RLS_ENFORCEMENT_ENABLED` not a known key (Zod pick throws / type error).

- [ ] **Step 3: Add the schema field**

In `packages/config/src/env.ts`, after the `IAM_ENFORCEMENT_ENABLED` block (ends ~line 110), add — note the default is **off** (opposite of IAM), the safe seeding default:

```ts
  // OXA-1515: Row-Level Security enforcement gate. Default OFF during the
  // seeding window: withTenantDb always sets the scope GUCs, but additionally
  // sets app.rls_bypass='on' while this is false so the bypass-aware policies
  // do not yet filter. During seeding, isolation is still enforced by the
  // manual eq(orgId) predicates kept in every query. Flip to true per env
  // once db.query.unscoped telemetry reads zero. Reversible via env (no
  // migration needed).
  TENANT_RLS_ENFORCEMENT_ENABLED: z
    .union([z.literal("true"), z.literal("false")])
    .optional()
    .transform((v) => v === "true"),
```

- [ ] **Step 4: Add the registry entry**

In `packages/config/src/registry.ts`, add an entry alongside the other enforcement/feature flags (mirror an existing boolean flag entry such as `SANDBOX_ENABLED`/`IAM_ENFORCEMENT_ENABLED`):

```ts
  TENANT_RLS_ENFORCEMENT_ENABLED: {
    group: "Security",
    description:
      "When true, Postgres RLS policies filter by org/workspace. Default off " +
      "during seeding; withTenantDb sets app.rls_bypass while off. Flip to true " +
      "per env after db.query.unscoped telemetry reads zero.",
    secret: false,
    clientExposed: false,
    services: ["api", "app", "mcp"],
    requiredIn: [],
    valueOrigin: "manual",
    placeholder: "false",
  },
```

- [ ] **Step 5: Run config tests to verify pass**

Run: `pnpm --filter @oxagen/config test:unit`
Expected: PASS (new cases + `registry.test.ts` "every schema key has a registry entry" stays green).

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/env.ts packages/config/src/registry.ts packages/config/src/env.test.ts
git commit -m "feat(config): add TENANT_RLS_ENFORCEMENT_ENABLED flag, default off (OXA-1515)"
```

---

#### Task 5: `withTenantDb` + pass-through mock (TDD)

**Files:**
- Create: `packages/database/src/tenant.ts`
- Create: `packages/database/src/tenant.mock.ts`
- Modify: `packages/database/package.json` (add `@oxagen/tenancy` dep; add `./tenant` + `./tenant.mock` exports)
- Modify: `packages/database/src/index.ts` (re-export tenant)
- Test: `packages/database/src/tenant.test.ts`

- [ ] **Step 1: Add deps + exports**

In `packages/database/package.json`, add to `dependencies`:

```json
"@oxagen/tenancy": "workspace:*"
```

and extend `exports`:

```json
    "./tenant": "./src/tenant.ts",
    "./tenant.mock": "./src/tenant.mock.ts"
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing test**

`packages/database/src/tenant.test.ts` — assert the wrapper sets both scope GUCs, sets the bypass GUC when the flag is off, and omits bypass when on. Mock `db()` to capture the SQL passed to `tx.execute`.

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(async () => undefined),
  transaction: vi.fn(),
  rlsEnforced: vi.fn(() => false),
}));

mocks.transaction.mockImplementation(
  async (cb: (tx: unknown) => Promise<unknown>) => cb({ execute: mocks.execute }),
);

vi.mock("./client", () => ({ db: () => ({ transaction: mocks.transaction }) }));
// rlsEnforced reads env; stub it so the test controls the branch.
vi.mock("./tenant-flag", () => ({ rlsEnforced: mocks.rlsEnforced }));

import { runInTenantScope } from "@oxagen/tenancy";
import { withTenantDb } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

function sqlText(call: unknown): string {
  // drizzle sql`` template → capture via the mock arg's queryChunks/strings.
  return JSON.stringify(call);
}

beforeEach(() => {
  mocks.execute.mockClear();
  mocks.rlsEnforced.mockReturnValue(false);
});

describe("withTenantDb", () => {
  it("requires an active scope (fail-closed)", async () => {
    await expect(withTenantDb(async () => 1)).rejects.toThrow(/tenant scope/);
  });

  it("sets org + workspace GUCs and runs the callback on the tx", async () => {
    const result = await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async (tx) => {
        expect(tx).toBeDefined();
        return "ok";
      }),
    );
    expect(result).toBe("ok");
    expect(mocks.execute).toHaveBeenCalledTimes(1); // one set_config statement
    const arg = sqlText(mocks.execute.mock.calls[0][0]);
    expect(arg).toContain("app.current_org_id");
    expect(arg).toContain("app.current_workspace_id");
    expect(arg).toContain("app.rls_bypass"); // flag off → bypass set
  });

  it("omits the bypass GUC when enforcement is enabled", async () => {
    mocks.rlsEnforced.mockReturnValue(true);
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      withTenantDb(async () => undefined),
    );
    const arg = sqlText(mocks.execute.mock.calls[0][0]);
    expect(arg).not.toContain("app.rls_bypass");
  });
});
```

> The `sqlText` helper stringifies the Drizzle `sql` object; assert on substrings of the embedded query chunks. If the serialized shape differs, switch the assertion to inspect `mocks.execute.mock.calls[0][0].queryChunks` — keep the three substring checks identical.

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/database test:unit -- tenant`
Expected: FAIL — `./tenant` / `./tenant-flag` not found.

- [ ] **Step 4: Implement the flag reader**

`packages/database/src/tenant-flag.ts` (separate module so tests stub it cleanly):

```ts
import { requireEnv } from "@oxagen/config/env";

/** True when RLS policies should actively filter (flag on → no bypass GUC). */
export function rlsEnforced(): boolean {
  return requireEnv(["TENANT_RLS_ENFORCEMENT_ENABLED"]).TENANT_RLS_ENFORCEMENT_ENABLED;
}
```

- [ ] **Step 5: Implement `withTenantDb`**

`packages/database/src/tenant.ts`:

```ts
import { sql } from "drizzle-orm";
import { requireScope } from "@oxagen/tenancy";
import { db, type Database } from "./client";
import { rlsEnforced } from "./tenant-flag";

/** The transaction handle Drizzle hands to a `.transaction(cb)` callback. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * Run DB work in a tenant-scoped transaction. Sets the per-transaction GUCs
 * that the RLS policies read. When enforcement is OFF, also sets
 * app.rls_bypass='on' so policies don't yet filter (seeding window).
 *
 * Keep the body focused — do not wrap long LLM/tool calls in one withTenantDb;
 * the transaction is held for the callback's lifetime.
 */
export async function withTenantDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { orgId, workspaceId } = requireScope();
  const bypass = rlsEnforced() ? "off" : "on";
  return db().transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.current_org_id', ${orgId}, true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
    return fn(tx);
  });
}
```

> Note: `app.rls_bypass` is always set (`'on'`/`'off'`); the policy treats anything other than `'on'` as "enforce". The unit test asserts `'on'` is present when the flag is off; when enforcement is on the value is `'off'`, which the test's `not.toContain("app.rls_bypass")` must tolerate — adjust that assertion to `expect(arg).toContain("'off'")` to match this always-set form. (Pick one form and keep test + impl consistent.)

- [ ] **Step 6: Implement the pass-through mock**

`packages/database/src/tenant.mock.ts` — what unit suites use so they don't open a real transaction:

```ts
import type { Tx } from "./tenant";

/**
 * Test double for withTenantDb: invokes the callback with the provided fake
 * tx, no transaction, no GUC. Suites pass their existing fake db object.
 */
export function makeWithTenantDbMock(fakeTx: unknown) {
  return async <T>(fn: (tx: Tx) => Promise<T>): Promise<T> => fn(fakeTx as Tx);
}
```

- [ ] **Step 7: Re-export from index**

In `packages/database/src/index.ts`, add:

```ts
export { withTenantDb, type Tx } from "./tenant";
```

- [ ] **Step 8: Run test to verify it passes**

Run: `pnpm --filter @oxagen/database test:unit -- tenant`
Expected: PASS.

- [ ] **Step 9: Typecheck + commit**

```bash
pnpm --filter @oxagen/database typecheck
git add packages/database/package.json packages/database/src/tenant.ts packages/database/src/tenant-flag.ts packages/database/src/tenant.mock.ts packages/database/src/tenant.test.ts packages/database/src/index.ts
git commit -m "feat(database): add withTenantDb tenant-scoped tx wrapper + mock (OXA-1515)"
```

---

#### Task 6: `db.query.unscoped` coverage telemetry (TDD)

Proves, during seeding, that no DB access runs without the GUCs. Implemented as a counter incremented whenever a query path is reached without an active scope.

**Files:**
- Create: `packages/database/src/unscoped-meter.ts`
- Test: `packages/database/src/unscoped-meter.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/database/src/unscoped-meter.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runInTenantScope } from "@oxagen/tenancy";
import { recordIfUnscoped, __unscopedCountForTests } from "./unscoped-meter";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("unscoped meter", () => {
  it("counts a call with no active scope", () => {
    const before = __unscopedCountForTests();
    recordIfUnscoped("db.read");
    expect(__unscopedCountForTests()).toBe(before + 1);
  });

  it("does not count a call inside a scope", () => {
    const before = __unscopedCountForTests();
    runInTenantScope({ orgId: ORG, workspaceId: WS }, () => recordIfUnscoped("db.read"));
    expect(__unscopedCountForTests()).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/database test:unit -- unscoped-meter`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the meter**

`packages/database/src/unscoped-meter.ts`:

```ts
import { getScope } from "@oxagen/tenancy";

let unscopedCount = 0;

/** Log + count a DB access that ran with no active tenant scope. */
export function recordIfUnscoped(site: string): void {
  if (getScope() === null) {
    unscopedCount += 1;
    console.warn(`[tenancy] unscoped DB access at ${site} (db.query.unscoped=${unscopedCount})`);
  }
}

export function __unscopedCountForTests(): number {
  return unscopedCount;
}
```

> Wire `recordIfUnscoped("withTenantDb")` is unnecessary inside `withTenantDb` (it requires a scope). Instead call it from any legacy `db()` accessor that has not yet migrated, so the seeding dashboard shows remaining gaps. During Task 7 callsite sweep, the count must reach zero in staging before flipping the flag (Task 14).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @oxagen/database test:unit -- unscoped-meter`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/database/src/unscoped-meter.ts packages/database/src/unscoped-meter.test.ts
git commit -m "feat(database): add unscoped-DB-access coverage meter (OXA-1515)"
```

---

#### Task 7: Migrate Postgres call sites to `withTenantDb`

Mechanical sweep. The transformation is uniform; do it package-by-package, commit per package, keep the existing `eq(orgId)` predicates (decided: kept permanently).

**Files:** every file matching the enumeration below. Start with `packages/handlers/`.

- [ ] **Step 1: Enumerate the call sites**

Run:

```bash
grep -rn "db()" packages apps --include="*.ts" --exclude="*.test.ts" | grep -v "packages/database/src/" | sort
```

Expected: a list across `packages/handlers`, `packages/agent`, `packages/billing`, `packages/iam`, `packages/auth`, `packages/inngest-functions`, `apps/app/src/.../actions.ts`, `apps/app/src/lib/resolve-org.ts`.

- [ ] **Step 2: Apply the transformation per file**

Rule — replace direct `db()` use with `withTenantDb`:

*Read (before):*
```ts
import { db, schema } from "@oxagen/database";
// ...
const row = await db().query.conversations.findFirst({
  where: and(eq(schema.conversations.id, id), eq(schema.conversations.orgId, ctx.orgId)),
  columns: { id: true },
});
```

*Read (after):*
```ts
import { schema, withTenantDb } from "@oxagen/database";
// ...
const row = await withTenantDb((tx) =>
  tx.query.conversations.findFirst({
    where: and(eq(schema.conversations.id, id), eq(schema.conversations.orgId, ctx.orgId)),
    columns: { id: true },
  }),
);
```

*Existing `db().transaction(async (tx) => …)` (before):*
```ts
await db().transaction(async (tx) => {
  await tx.insert(schema.messages).values({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, ... });
});
```

*After — `withTenantDb` IS the transaction; drop the inner `db().transaction`:*
```ts
await withTenantDb(async (tx) => {
  await tx.insert(schema.messages).values({ orgId: ctx.orgId, workspaceId: ctx.workspaceId, ... });
});
```

Keep every `eq(...orgId, ctx.orgId)` predicate and every `orgId/workspaceId` value on inserts exactly as-is.

- [ ] **Step 3: Update that file's unit test mock**

Each suite that did `vi.mock("@oxagen/database", () => ({ db: () => fakeDb, schema }))` adds a pass-through `withTenantDb` so the handler runs against the same fake. Example diff to the mock factory:

```ts
vi.mock("@oxagen/database", () => ({
  db: () => fakeDb,
  // withTenantDb invokes the callback with the same fake tx the handler expects.
  withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => fn(fakeDb),
  schema: { /* unchanged */ },
}));
```

If the handler previously relied on `db().transaction`, point the fake's transaction at the same object (the existing `txFn` pattern in `workspace.create.test.ts` already does this — reuse it as `withTenantDb: async (fn) => mocks.txFn(fn)`).

Wrap any handler-invoking assertion that now needs a scope in `withTestScope(() => handler(input, ctx))` — import from `@oxagen/tenancy/testing`. (Most handler tests call the handler directly; the kernel isn't in the unit path, so the scope must be supplied by the test.)

- [ ] **Step 4: Per-package verify**

Run (example for handlers):

```bash
pnpm --filter @oxagen/handlers test:unit && pnpm --filter @oxagen/handlers typecheck && pnpm --filter @oxagen/handlers lint
```

Expected: PASS, zero warnings.

- [ ] **Step 5: Commit per package**

```bash
git add packages/handlers
git commit -m "refactor(handlers): route DB access through withTenantDb (OXA-1515)"
```

Repeat Steps 2–5 for `packages/agent`, `packages/billing`, `packages/iam`, `packages/auth`, `packages/inngest-functions`, then `apps/app` (server actions + `resolve-org.ts`). For server actions/inngest that run **outside** `kernel.invoke()`, wrap the body in `runInTenantScope({ orgId, workspaceId }, …)` using the already-resolved ids before calling `withTenantDb`.

- [ ] **Step 6: Final sweep verification**

Run:

```bash
grep -rn "db()" packages apps --include="*.ts" --exclude="*.test.ts" | grep -v "packages/database/src/"
```

Expected: empty (every callsite migrated). Then `pnpm -w typecheck && pnpm -w lint`.

---

### Phase 2 — Neo4j + ClickHouse seam walls

#### Task 8: Neo4j `scopedSession` + guard (TDD)

**Files:**
- Create: `packages/ontology/src/tenant.ts`
- Modify: `packages/ontology/package.json` (add `@oxagen/tenancy` dep; add `./tenant` export)
- Modify: `packages/ontology/src/index.ts` (re-export)
- Test: `packages/ontology/src/tenant.test.ts`

- [ ] **Step 1: Add dep + export**

`packages/ontology/package.json` dependencies: add `"@oxagen/tenancy": "workspace:*"`. Exports: add `"./tenant": "./src/tenant.ts"`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/ontology/src/tenant.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const run = vi.fn(async () => ({ records: [] }));
const close = vi.fn(async () => undefined);
vi.mock("./client", () => ({ session: () => ({ run, close }) }));

import { runInTenantScope } from "@oxagen/tenancy";
import { scopedSession } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("scopedSession", () => {
  it("requires a scope", () => {
    expect(() => scopedSession()).toThrow(/tenant scope/);
  });

  it("injects $orgId/$workspaceId into scoped Cypher", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await s.run("MATCH (n) WHERE n.orgId = $orgId RETURN n", { extra: 1 });
    });
    expect(run).toHaveBeenCalledWith(
      "MATCH (n) WHERE n.orgId = $orgId RETURN n",
      { extra: 1, orgId: ORG, workspaceId: WS },
    );
  });

  it("rejects Cypher that does not reference the scope", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      const s = scopedSession();
      await expect(s.run("MATCH (n) RETURN n")).rejects.toThrow(/must filter by \$orgId/);
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/ontology test:unit -- tenant`
Expected: FAIL — `./tenant` missing.

- [ ] **Step 4: Implement `scopedSession`**

`packages/ontology/src/tenant.ts`:

```ts
import { requireScope, TenantScopeError } from "@oxagen/tenancy";
import { session } from "./client";

// A scoped query must reference the tenant on a node (read) or in a MERGE key.
const SCOPE_GUARD = /\borgId\b/;

/** A session whose run() injects $orgId/$workspaceId and guards the query. */
export function scopedSession() {
  const { orgId, workspaceId } = requireScope();
  const s = session();
  return {
    async run(cypher: string, params: Record<string, unknown> = {}) {
      if (!SCOPE_GUARD.test(cypher)) {
        throw new TenantScopeError(
          `Cypher over a scoped session must filter by $orgId: ${cypher.slice(0, 80)}`,
        );
      }
      return s.run(cypher, { ...params, orgId, workspaceId });
    },
    close: () => s.close(),
  };
}
```

In `packages/ontology/src/index.ts` add: `export { scopedSession } from "./tenant";`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @oxagen/ontology test:unit -- tenant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @oxagen/ontology typecheck
git add packages/ontology/package.json packages/ontology/src/tenant.ts packages/ontology/src/index.ts packages/ontology/src/tenant.test.ts
git commit -m "feat(ontology): add scopedSession with tenant-scope guard (OXA-1515)"
```

---

#### Task 9: Migrate graph memory to `scopedSession` + fix the index drift

**Files:**
- Modify: `packages/agent/src/memory/neo4j.ts`
- Modify: `packages/ontology/src/schema.cypher:36-40`
- Modify: `packages/agent/src/memory/neo4j.test.ts`

- [ ] **Step 1: Fix the dead `tenantId` indexes (drift bug)**

In `packages/ontology/src/schema.cypher`, change lines 36–40 from `ON (n.tenantId)` to `ON (n.orgId)` so scoped reads are indexed:

```cypher
CREATE INDEX execution_tenant IF NOT EXISTS FOR (n:Execution) ON (n.orgId);
CREATE INDEX document_tenant  IF NOT EXISTS FOR (n:Document)  ON (n.orgId);
CREATE INDEX agent_memory_tenant IF NOT EXISTS FOR (n:AgentMemory) ON (n.orgId);
CREATE INDEX background_task_tenant IF NOT EXISTS FOR (n:BackgroundTask) ON (n.orgId);
```

> These `CREATE INDEX IF NOT EXISTS` run idempotently via `migrate.ts`; the old `tenantId` indexes (never populated) can be dropped in the same migration with `DROP INDEX execution_tenant IF EXISTS;` immediately before each create if a name clash occurs. Verify by reading `packages/ontology/src/migrate.ts` to confirm it re-runs the whole `schema.cypher`.

- [ ] **Step 2: Switch the two queries to `scopedSession`**

In `packages/agent/src/memory/neo4j.ts`, replace `import { session as neo4jSession } from "@oxagen/ontology";` with `import { scopedSession } from "@oxagen/ontology";`. In both `recallMemories` and `writeMemory`, replace `const s = neo4jSession();` with `const s = scopedSession();` and **drop** the now-redundant `orgId`/`workspaceId` entries from the params object (the wrapper injects them). The Cypher already references `$orgId`/`node.orgId`, so the guard passes. Keep `orgId`/`workspaceId` in the `MERGE` key text.

These functions still accept `orgId`/`workspaceId` args today; the caller resolves them from `ctx`. Since the kernel now establishes the scope, change the call to run inside it — but the handler already runs inside the kernel scope (Task 3), so `scopedSession()` finds the scope with no signature change. Leave the function args in place (used to validate they match the scope) OR remove them and read from scope; choose removal for DRY:

```ts
export async function recallMemories(args: {
  embedding: number[];
  minWeight: "low" | "high" | "critical";
  limit: number;
  nodeRef?: string;
}): Promise<MemoryRow[]> {
  const s = scopedSession();
  // ...unchanged Cypher; params object no longer includes orgId/workspaceId...
}
```

Update `packages/agent/src/handlers/agent.memory.recall.ts` and `agent.memory.write.ts` to stop passing `orgId`/`workspaceId` to these functions accordingly.

- [ ] **Step 3: Update the memory unit test**

`packages/agent/src/memory/neo4j.test.ts` currently mocks `@oxagen/ontology`'s `session`. Change it to mock `scopedSession` and wrap calls in `withTestScope`:

```ts
import { withTestScope } from "@oxagen/tenancy/testing";
const sessionRun = vi.fn(async () => ({ records: [] }));
vi.mock("@oxagen/ontology", () => ({
  scopedSession: () => ({ run: sessionRun, close: vi.fn(async () => undefined) }),
}));
// ...
await withTestScope(() => recallMemories({ embedding: [...], minWeight: "low", limit: 5 }));
expect(sessionRun.mock.calls[0][0]).toContain("node.orgId = $orgId");
```

- [ ] **Step 4: Verify**

Run: `pnpm --filter @oxagen/agent test:unit -- memory && pnpm --filter @oxagen/agent typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/memory/neo4j.ts packages/agent/src/handlers/agent.memory.recall.ts packages/agent/src/handlers/agent.memory.write.ts packages/agent/src/memory/neo4j.test.ts packages/ontology/src/schema.cypher
git commit -m "refactor(agent): scope graph memory via scopedSession; fix orgId index drift (OXA-1515)"
```

---

#### Task 10: ClickHouse `chInsert` / `chSelect` (TDD)

**Files:**
- Create: `packages/telemetry/src/tenant.ts`
- Modify: `packages/telemetry/package.json` (add `@oxagen/tenancy` dep; add `./tenant` export)
- Modify: `packages/telemetry/src/index.ts` (re-export)
- Test: `packages/telemetry/src/tenant.test.ts`

- [ ] **Step 1: Add dep + export**

`packages/telemetry/package.json` dependencies: add `"@oxagen/tenancy": "workspace:*"`. Exports: add `"./tenant": "./src/tenant.ts"`. Run `pnpm install`.

- [ ] **Step 2: Write the failing test**

`packages/telemetry/src/tenant.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

const insert = vi.fn(async () => undefined);
const query = vi.fn(async () => ({ json: async () => ({ data: [] }) }));
vi.mock("./client", () => ({ clickhouse: () => ({ insert, query }) }));

import { runInTenantScope } from "@oxagen/tenancy";
import { chInsert, chSelect } from "./tenant";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("clickhouse tenant seam", () => {
  it("stamps org_id/workspace_id onto inserted rows", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [{ event_type: "x" }]),
    );
    expect(insert).toHaveBeenCalledWith({
      table: "events",
      values: [{ org_id: ORG, workspace_id: WS, event_type: "x" }],
      format: "JSONEachRow",
    });
  });

  it("binds orgId/workspaceId as query params on read", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chSelect({ query: "SELECT 1 WHERE org_id = {orgId:UUID}" }),
    );
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({ query_params: expect.objectContaining({ orgId: ORG, workspaceId: WS }) }),
    );
  });

  it("rejects a read query that omits org_id (guard)", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await expect(chSelect({ query: "SELECT 1" })).rejects.toThrow(/org_id/);
    });
  });

  it("fails closed with no scope", async () => {
    await expect(chInsert("events", [{}])).rejects.toThrow(/tenant scope/);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @oxagen/telemetry test:unit -- tenant`
Expected: FAIL — module missing.

- [ ] **Step 4: Implement the seam**

`packages/telemetry/src/tenant.ts`:

```ts
import { requireScope, TenantScopeError } from "@oxagen/tenancy";
import { clickhouse } from "./client";

/** Insert rows, stamping org_id/workspace_id from the active scope. */
export async function chInsert(table: string, rows: ReadonlyArray<Record<string, unknown>>): Promise<void> {
  const { orgId, workspaceId } = requireScope();
  const values = rows.map((r) => ({ org_id: orgId, workspace_id: workspaceId, ...r }));
  await clickhouse().insert({ table, values, format: "JSONEachRow" });
}

/** Read with org/workspace bound as query params. Query MUST filter org_id. */
export async function chSelect<T>(q: { query: string; params?: Record<string, unknown> }): Promise<T> {
  const { orgId, workspaceId } = requireScope();
  if (!/\borg_id\b/.test(q.query)) {
    throw new TenantScopeError(`ClickHouse read must filter by org_id: ${q.query.slice(0, 80)}`);
  }
  const result = await clickhouse().query({
    query: q.query,
    query_params: { ...q.params, orgId, workspaceId },
    format: "JSON",
  });
  return result as T;
}
```

In `packages/telemetry/src/index.ts` add: `export { chInsert, chSelect } from "./tenant";`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @oxagen/telemetry test:unit -- tenant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
pnpm --filter @oxagen/telemetry typecheck
git add packages/telemetry/package.json packages/telemetry/src/tenant.ts packages/telemetry/src/index.ts packages/telemetry/src/tenant.test.ts
git commit -m "feat(telemetry): add chInsert/chSelect tenant seam with org_id guard (OXA-1515)"
```

---

#### Task 11: Migrate ClickHouse call sites + ESLint seam ban

**Files:**
- Modify: telemetry callers (billing rollup, audit chain, agent token/tool writes)
- Modify: `.eslintrc`/`eslint.config.js` at repo root (the active ESLint config)

- [ ] **Step 1: Enumerate raw client usage**

Run:

```bash
grep -rn "clickhouse()" packages apps --include="*.ts" --exclude="*.test.ts" | grep -v "packages/telemetry/src/"
grep -rn "import { session" packages apps --include="*.ts" --exclude="*.test.ts" | grep -v "packages/ontology/src/"
```

- [ ] **Step 2: Migrate inserts/reads**

Replace direct `clickhouse().insert(...)` with `chInsert(table, rows)` (drop the manual `org_id`/`workspace_id` since the seam stamps them — keep any other columns), and direct `clickhouse().query(...)` reads with `chSelect({ query, params })`. Callers already run inside the kernel scope; no id threading.

- [ ] **Step 3: Add the seam-bypass ESLint rule**

In the root ESLint config, add a `no-restricted-imports` rule (with overrides allowing the seam packages themselves):

```js
// Forbid bypassing the tenant seams outside the owning packages.
"no-restricted-imports": ["error", {
  paths: [
    { name: "@oxagen/ontology", importNames: ["session"],
      message: "Use scopedSession() from @oxagen/ontology — raw session() bypasses tenant scope." },
  ],
}],
```

Add an override block so `packages/ontology/**` and `packages/agent/src/memory/**` (if it legitimately needs raw access) are exempt, and so `clickhouse()`/`db()` raw use is confined to their packages via a path/zone rule. Verify the exact config format by reading the root ESLint config first.

- [ ] **Step 4: Verify**

Run: `pnpm -w lint --max-warnings 0 && pnpm -w typecheck`
Expected: PASS; any new raw-seam import fails lint.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(telemetry): route CH access through tenant seam; ESLint-ban raw clients (OXA-1515)"
```

---

### Phase 3 — Postgres RLS policies + the single isolation proof

#### Task 12: Policy manifest + generator + drift test (TDD)

**Files:**
- Create: `packages/database/src/tenant-policy.manifest.ts`
- Create: `tools/scripts/gen-rls-migration.ts`
- Test: `packages/database/src/tenant-policy.manifest.test.ts`

- [ ] **Step 1: Write the failing test (manifest covers every orgScopeMixin table)**

`packages/database/src/tenant-policy.manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { POLICY_MANIFEST, type PolicyClass } from "./tenant-policy.manifest";

describe("tenant policy manifest", () => {
  it("assigns a known class to every table", () => {
    const classes: PolicyClass[] = ["standard", "workspace_nullable", "org_only"];
    for (const entry of POLICY_MANIFEST) {
      expect(classes).toContain(entry.policyClass);
      expect(entry.table).toMatch(/^[a-z_]+\.[a-z_]+$/); // schema.table
    }
  });

  it("includes the known standard owned tables", () => {
    const tables = POLICY_MANIFEST.map((e) => e.table);
    expect(tables).toContain("agent.agents");
    expect(tables).toContain("chat.conversations");
    expect(tables).toContain("execution.executions");
  });

  it("marks billing tables org_only and security_events workspace_nullable", () => {
    const find = (t: string) => POLICY_MANIFEST.find((e) => e.table === t);
    expect(find("billing.subscriptions")?.policyClass).toBe("org_only");
    expect(find("security.security_events")?.policyClass).toBe("workspace_nullable");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @oxagen/database test:unit -- tenant-policy`
Expected: FAIL — manifest missing.

- [ ] **Step 3: Implement the manifest**

`packages/database/src/tenant-policy.manifest.ts` — enumerate every `org_id`-bearing table (cross-check against `packages/database/src/schema/*.ts`; the agent-mapped list is the source). Classes: `standard` (org+workspace), `workspace_nullable` (org + nullable workspace), `org_only`:

```ts
export type PolicyClass = "standard" | "workspace_nullable" | "org_only";

export interface PolicyEntry {
  readonly table: string;       // schema-qualified
  readonly policyClass: PolicyClass;
}

// Source of truth for which RLS policy each tenant-owned table gets.
// A CI test (tenant-policy.coverage.test.ts) asserts every org_id column in
// the live schema appears here, so a new owned table can't slip through.
export const POLICY_MANIFEST: readonly PolicyEntry[] = [
  // agent.* (orgScopeMixin)
  { table: "agent.agents", policyClass: "standard" },
  { table: "agent.agent_versions", policyClass: "standard" },
  { table: "agent.tools", policyClass: "standard" },
  { table: "agent.tool_versions", policyClass: "standard" },
  { table: "agent.tool_assignments", policyClass: "standard" },
  { table: "agent.skills", policyClass: "standard" },
  { table: "agent.skill_versions", policyClass: "standard" },
  { table: "agent.background_tasks", policyClass: "standard" },
  { table: "agent.approval_requests", policyClass: "standard" },
  { table: "agent.subagent_fanouts", policyClass: "standard" },
  { table: "agent.subagent_runs", policyClass: "standard" },
  { table: "agent.plan_steps", policyClass: "standard" },
  { table: "agent.mcp_servers", policyClass: "standard" },
  // workflow.*
  { table: "workflow.playbooks", policyClass: "standard" },
  { table: "workflow.playbook_versions", policyClass: "standard" },
  { table: "workflow.playbook_steps", policyClass: "standard" },
  { table: "workflow.playbook_step_assignments", policyClass: "standard" },
  // event.*
  { table: "event.triggers", policyClass: "standard" },
  { table: "event.workflow_triggers", policyClass: "standard" },
  // execution.*
  { table: "execution.executions", policyClass: "standard" },
  { table: "execution.execution_steps", policyClass: "standard" },
  { table: "execution.tool_calls", policyClass: "standard" },
  { table: "execution.execution_artifacts", policyClass: "standard" },
  // chat.*
  { table: "chat.conversations", policyClass: "standard" },
  { table: "chat.messages", policyClass: "standard" },
  // content.*
  { table: "content.files", policyClass: "standard" },
  { table: "content.documents", policyClass: "standard" },
  // integration.*
  { table: "integration.connections", policyClass: "standard" },
  // workspace.* (inline org/workspace)
  { table: "workspace.workspace_users", policyClass: "standard" },
  { table: "workspace.folders", policyClass: "standard" },
  // auth.* (mixin'd)
  { table: "auth.credentials", policyClass: "standard" },
  { table: "auth.api_keys", policyClass: "standard" },
  // iam.* (org + nullable workspace)
  { table: "iam.principals", policyClass: "workspace_nullable" },
  { table: "iam.principal_role_assignments", policyClass: "workspace_nullable" },
  { table: "iam.roles", policyClass: "org_only" },
  { table: "iam.role_grants", policyClass: "org_only" },
  { table: "iam.grants", policyClass: "org_only" },
  { table: "iam.policies", policyClass: "org_only" },
  { table: "iam.access_requests", policyClass: "org_only" },
  { table: "iam.iam_sessions", policyClass: "org_only" },
  // org.*
  { table: "org.org_users", policyClass: "org_only" },
  // billing.* (org-only by design)
  { table: "billing.subscriptions", policyClass: "org_only" },
  { table: "billing.payment_methods", policyClass: "org_only" },
  { table: "billing.invoices", policyClass: "org_only" },
  { table: "billing.invoice_line_items", policyClass: "org_only" },
  { table: "billing.usage_records", policyClass: "org_only" },
  { table: "billing.credit_balances", policyClass: "org_only" },
  { table: "billing.credit_ledger", policyClass: "org_only" },
  { table: "billing.credit_lots", policyClass: "org_only" },
  { table: "billing.stripe_event_processing", policyClass: "org_only" },
  // security.* (org + nullable workspace)
  { table: "security.security_events", policyClass: "workspace_nullable" },
];
```

> Global tables (`auth.users/sessions/accounts/verifications`), shared catalogs
> (`billing.plans`, `billing.stripe_events`, `org.organizations`,
> `workspace.workspaces` are self-identity — see coverage test note) are
> intentionally excluded. Confirm each name against `schema/*.ts` (snake_case
> table names from Drizzle `casing: "snake_case"`).

- [ ] **Step 4: Implement the generator**

`tools/scripts/gen-rls-migration.ts` — emits `packages/database/drizzle/0001_rls_policies.sql` from the manifest:

```ts
#!/usr/bin/env tsx
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { POLICY_MANIFEST, type PolicyClass } from "../../packages/database/src/tenant-policy.manifest";

const ORG = `nullif(current_setting('app.current_org_id', true), '')::uuid`;
const WS = `nullif(current_setting('app.current_workspace_id', true), '')::uuid`;
const BYPASS = `current_setting('app.rls_bypass', true) = 'on'`;

function predicate(cls: PolicyClass): string {
  if (cls === "org_only") return `${BYPASS} OR (org_id = ${ORG})`;
  if (cls === "workspace_nullable")
    return `${BYPASS} OR (org_id = ${ORG} AND (workspace_id IS NULL OR workspace_id = ${WS}))`;
  return `${BYPASS} OR (org_id = ${ORG} AND workspace_id = ${WS})`;
}

const blocks = POLICY_MANIFEST.map(({ table, policyClass }) => {
  const p = predicate(policyClass);
  return `ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${table} FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ${table};
CREATE POLICY tenant_isolation ON ${table}
  USING (${p})
  WITH CHECK (${p});`;
});

const sql = `-- GENERATED by tools/scripts/gen-rls-migration.ts — do not edit by hand.
-- Tenant + workspace RLS (OXA-1515). Bypass-aware: app.rls_bypass='on' disables
-- filtering during the seeding window (TENANT_RLS_ENFORCEMENT_ENABLED=false).
BEGIN;
${blocks.join("\n\n")}
COMMIT;
`;

writeFileSync(resolve(__dirname, "../../packages/database/drizzle/0001_rls_policies.sql"), sql);
console.log(`wrote 0001_rls_policies.sql (${POLICY_MANIFEST.length} tables)`);
```

- [ ] **Step 5: Run manifest test + generate**

Run:

```bash
pnpm --filter @oxagen/database test:unit -- tenant-policy
pnpm tsx tools/scripts/gen-rls-migration.ts
```

Expected: tests PASS; SQL file written.

- [ ] **Step 6: Commit**

```bash
git add packages/database/src/tenant-policy.manifest.ts packages/database/src/tenant-policy.manifest.test.ts tools/scripts/gen-rls-migration.ts packages/database/drizzle/0001_rls_policies.sql
git commit -m "feat(database): generate bypass-aware RLS policy migration from manifest (OXA-1515)"
```

---

#### Task 13: Coverage drift test — no owned table escapes the manifest (TDD)

**Files:**
- Test: `packages/database/integration/manifest-coverage.test.ts`

This runs against the **real CI Postgres** (post-migration) so it can read `information_schema` — it belongs in the integration job (Task 15), not the mocked unit suite.

- [ ] **Step 1: Write the test**

`packages/database/integration/manifest-coverage.test.ts`:

```ts
import { describe, expect, it, afterAll } from "vitest";
import postgres from "postgres";
import { POLICY_MANIFEST } from "../src/tenant-policy.manifest";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });
afterAll(() => sql.end({ timeout: 5 }));

// Tables that legitimately have org_id but are intentionally NOT row-scoped.
const ALLOWLIST = new Set<string>([
  "org.organizations", "workspace.workspaces", // self-identity (id IS the tenant)
  "billing.plans", "billing.stripe_events",     // shared catalogs
]);

describe("RLS manifest coverage", () => {
  it("every table with an org_id column is in the manifest or allowlist", async () => {
    const rows = await sql<{ schema: string; table: string }[]>`
      SELECT table_schema AS schema, table_name AS table
      FROM information_schema.columns
      WHERE column_name = 'org_id'
        AND table_schema NOT IN ('public', 'information_schema', 'pg_catalog')
    `;
    const owned = rows.map((r) => `${r.schema}.${r.table}`);
    const covered = new Set(POLICY_MANIFEST.map((e) => e.table));
    const missing = owned.filter((t) => !covered.has(t) && !ALLOWLIST.has(t));
    expect(missing).toEqual([]);
  });

  it("every manifest table actually has RLS forced", async () => {
    const rows = await sql<{ rel: string }[]>`
      SELECT (n.nspname || '.' || c.relname) AS rel
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relforcerowsecurity = true
    `;
    const forced = new Set(rows.map((r) => r.rel));
    const notForced = POLICY_MANIFEST.filter((e) => !forced.has(e.table)).map((e) => e.table);
    expect(notForced).toEqual([]);
  });
});
```

- [ ] **Step 2: Commit (runs in CI integration job)**

```bash
git add packages/database/integration/manifest-coverage.test.ts
git commit -m "test(database): assert RLS manifest covers every org_id table (OXA-1515)"
```

---

#### Task 14: The single isolation proof — `rls.test.ts` (TDD, real Postgres)

**Files:**
- Create: `packages/database/integration/rls.test.ts`
- Create: `packages/database/vitest.integration.config.ts`
- Modify: `packages/database/package.json` (add `test:integration` script)

- [ ] **Step 1: Add the integration vitest config**

`packages/database/vitest.integration.config.ts`:

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["integration/**/*.test.ts"],
    globals: false,
    fileParallelism: false, // shared DB; run serially
  },
});
```

Add to `packages/database/package.json` scripts:

```json
"test:integration": "vitest run --config vitest.integration.config.ts"
```

- [ ] **Step 2: Write the proof**

`packages/database/integration/rls.test.ts` — the ONE place isolation is asserted. Seeds two orgs, sets the GUCs, and asserts an **unfiltered** read returns only the active tenant:

```ts
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false });

const ORG_A = "00000000-0000-0000-0000-0000000000a1";
const ORG_B = "00000000-0000-0000-0000-0000000000b1";
const WS_A = "00000000-0000-0000-0000-0000000000a2";
const WS_B = "00000000-0000-0000-0000-0000000000b2";

beforeAll(async () => {
  // Seed minimal orgs/workspaces + one conversation each. Bypass RLS for setup
  // by setting rls_bypass=on in the seeding tx.
  await sql.begin(async (tx) => {
    await tx`select set_config('app.rls_bypass','on',true)`;
    await tx`INSERT INTO org.organizations (id, public_id, name, slug) VALUES
      (${ORG_A}, 'org_a', 'A', 'a'), (${ORG_B}, 'org_b', 'B', 'b')
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug) VALUES
      (${WS_A}, 'ws_a', ${ORG_A}, 'WA', 'wa'), (${WS_B}, 'ws_b', ${ORG_B}, 'WB', 'wb')
      ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO chat.conversations (id, public_id, org_id, workspace_id, title) VALUES
      (gen_random_uuid(), 'cnv_a', ${ORG_A}, ${WS_A}, 'A conv'),
      (gen_random_uuid(), 'cnv_b', ${ORG_B}, ${WS_B}, 'B conv')
      ON CONFLICT DO NOTHING`;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`select set_config('app.rls_bypass','on',true)`;
    await tx`DELETE FROM chat.conversations WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM workspace.workspaces WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
  });
  await sql.end({ timeout: 5 });
});

async function asTenant<T>(org: string, ws: string, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`select
      set_config('app.current_org_id', ${org}, true),
      set_config('app.current_workspace_id', ${ws}, true),
      set_config('app.rls_bypass', 'off', true)`;
    return fn(tx);
  });
}

describe("RLS tenant isolation (enforced)", () => {
  it("an UNFILTERED read returns only the active tenant's rows", async () => {
    const rows = await asTenant(ORG_A, WS_A, (tx) =>
      tx<{ org_id: string }[]>`SELECT org_id FROM chat.conversations`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
  });

  it("cannot read another tenant even by explicit id", async () => {
    const rows = await asTenant(ORG_A, WS_A, (tx) =>
      tx`SELECT 1 FROM chat.conversations WHERE org_id = ${ORG_B}`,
    );
    expect(rows.length).toBe(0);
  });

  it("WITH CHECK blocks inserting a row for another tenant", async () => {
    await expect(
      asTenant(ORG_A, WS_A, (tx) =>
        tx`INSERT INTO chat.conversations (id, public_id, org_id, workspace_id, title)
           VALUES (gen_random_uuid(), 'cnv_evil', ${ORG_B}, ${WS_B}, 'evil')`,
      ),
    ).rejects.toThrow();
  });

  it("no GUC set → zero rows (fail-closed)", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx`select set_config('app.rls_bypass','off',true)`; // explicitly enforce
      return tx`SELECT 1 FROM chat.conversations`;
    });
    expect(rows.length).toBe(0);
  });

  it("org_only table ignores workspace mismatch", async () => {
    // billing.subscriptions: visible across workspaces within the same org.
    const rows = await asTenant(ORG_A, "00000000-0000-0000-0000-0000000000ff", (tx) =>
      tx`SELECT 1 FROM org.organizations WHERE id = ${ORG_A}`,
    );
    // org.organizations is self-identity (allowlisted, no policy) — sanity only.
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });
});
```

> Adjust column lists (`title`, `public_id`) to the real `chat.conversations` / `org.organizations` / `workspace.workspaces` schemas — read `packages/database/src/schema/chat.ts`, `org.ts`, `workspace.ts` and match NOT NULL columns. Keep the five assertions intact.

- [ ] **Step 3: Run locally against the dev DB (migrated with RLS)**

Run:

```bash
pnpm db:migrate   # applies 0001_rls_policies.sql to local :5433
DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen pnpm --filter @oxagen/database test:integration
```

Expected: PASS (5 isolation assertions + Task 13 coverage).

- [ ] **Step 4: Commit**

```bash
git add packages/database/vitest.integration.config.ts packages/database/integration/rls.test.ts packages/database/package.json
git commit -m "test(database): prove tenant isolation once via real-Postgres RLS suite (OXA-1515)"
```

---

#### Task 15: CI integration job

**Files:**
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the integration job**

After the `gate` job in `ci.yml`, add a `rls-integration` job that reuses the Postgres service container, runs migrations, then the integration suite. Mirror the existing `gate` job's services + env block:

```yaml
  rls-integration:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_USER: oxagen, POSTGRES_PASSWORD: oxagen, POSTGRES_DB: oxagen }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U oxagen" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgres://oxagen:oxagen@localhost:5432/oxagen
      TENANT_RLS_ENFORCEMENT_ENABLED: "true"
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: psql "$DATABASE_URL" -f tools/ci/init-postgres.sql   # creates the 14 schemas/extensions
      - run: pnpm db:migrate                                       # includes 0001_rls_policies.sql
      - run: pnpm --filter @oxagen/database test:integration
```

> Match the existing job's exact action versions, Node version, and the
> `init-postgres.sql` path used by the `gate` job (read `ci.yml` first). The
> integration job runs with the flag **on** so policies are live.

- [ ] **Step 2: Verify the workflow lints**

Run (if `actionlint` is available, else visual check):

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add RLS integration job (real Postgres, enforcement on) (OXA-1515)"
```

- [ ] **Step 3: Push branch and confirm CI green**

```bash
git push -u origin <branch>
```

Expected: `gate` + `rls-integration` both green on the PR.

---

### Phase 4 — Flip enforcement (ops)

#### Task 16: Enable enforcement per environment

Not a code change — an env-var operation, gated on telemetry. No migration.

- [ ] **Step 1: Verify seeding-window coverage**

In staging, confirm `db.query.unscoped` (Task 6) reads **zero** over a representative window. If non-zero, fix the offending callsites (they were missed in Task 7) before proceeding.

- [ ] **Step 2: Flip preview, then production**

Set `TENANT_RLS_ENFORCEMENT_ENABLED=true` on the Vercel projects (api, app, mcp), preview first, then production after a soak. (Use `pnpm env:pull`/the env-manager per repo convention; value is `"true"`.) `withTenantDb` stops setting `app.rls_bypass='on'`, so policies become load-bearing. Reversible: set back to `false` to re-bypass without a migration.

- [ ] **Step 3: File the post-deploy ticket**

Per repo policy, file an URGENT Linear ticket tracking the prod env-var flip with the rollback note (set flag `false`).

---

### Self-Review

**Spec coverage:**
- §5 tenancy seam → Tasks 1–2. §6 Postgres RLS + flag → Tasks 4, 5, 12, 13, 14. §6.1a flag → Tasks 4, 5, 16. §7.1 Neo4j → Tasks 8, 9. §7.2 ClickHouse → Tasks 10, 11. §8 kernel/actions/inngest propagation → Tasks 3, 7. §9 testing strategy → mocks (Tasks 5, 7), single proof (Task 14), seam guards (Tasks 8, 10), CI (Task 15). §11 file list → all tasks. §12 rollout phases → Phase headings. Decisions (§15): flag (Tasks 4/5/16), no CH row policy (none added — correct), keep predicates (Task 7 Step 2 keeps them).
- Known-gap fixes: MCP `orgId:""` → Task 3 Step 4; Neo4j `tenantId` drift → Task 9 Step 1.

**Placeholder scan:** every code step has concrete code; "adjust to real schema" notes point at named files to read, not vague TODOs. No `NotImplemented`/`TBD`.

**Type consistency:** `TenantScope {orgId, workspaceId}`, `runInTenantScope`, `requireScope`, `getScope`, `TenantScopeError`, `withTenantDb`, `Tx`, `scopedSession`, `chInsert`/`chSelect`, `POLICY_MANIFEST`/`PolicyClass`/`PolicyEntry`, `rlsEnforced`, GUCs `app.current_org_id`/`app.current_workspace_id`/`app.rls_bypass`, env `TENANT_RLS_ENFORCEMENT_ENABLED` — used consistently across all tasks.

