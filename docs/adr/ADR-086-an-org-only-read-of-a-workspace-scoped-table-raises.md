# ADR-086: An org-only read of a workspace-scoped table raises, and the static check retires

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform, app
- **Supersedes:** ADR-074 decision 3 (`pnpm check:org-sentinel-reads` as the
  enforcement). ADR-074's Context, its account of what RLS was also doing, and
  its rule that a conversion states which plane its table is on all stand.
- **Related:** ADR-068 (one org-only workspace sentinel, shared by every
  surface), ADR-042 (data planes), ADR-054 (the migration connection carries the
  RLS bypass),
  `packages/oxagen/src/types.ts` (`ORG_ONLY_WORKSPACE_ID`),
  `packages/database/src/tenant.ts` (`ORG_ONLY_WORKSPACE_GUC`, `withOrgDb`),
  `packages/database/src/tenant-policy.manifest.ts`,
  `tools/scripts/gen-rls-migration.ts`,
  `packages/database/integration/org-only-sentinel-refusal.test.ts`

## Context

An organisation-level surface has no workspace. `scoped: true` capabilities and
`runInTenantScope` both want a uuid, so such a surface carries the nil uuid —
the org-only workspace sentinel — as its `workspaceId`, and `withTenantDb`
copied it into `app.current_workspace_id`.

Every `tenant_isolation` policy the generator emits reads that GUC as
`nullif(current_setting('app.current_workspace_id', true), '')::uuid`. The nil
uuid casts cleanly and matches no workspace, so under the sentinel:

| class | what a read got |
|---|---|
| `org_only` | the whole org |
| `org_or_global` | the whole org, plus the global rows |
| `workspace_nullable` | **only** the rows whose `workspace_id IS NULL` |
| `standard` | **nothing** |
| `workspace_only` | **nothing** |

Postgres RLS hides rather than refuses. No error, no log line, nothing for a
`catch` to see: the caller got a short answer shaped exactly like a complete
one. ADR-074's Context has the seven live instances, including a signed SOC 2
export that omitted every workspace-scoped security event and a posture tile
that read zero denied invocations while the kernel was denying.

### Why the static check is being retired rather than extended

ADR-074 answered this by reading the source. `check-org-sentinel-reads.mjs`
resolved every table a sentinel-scoped tenant read touched through the policy
manifest and failed on the ones the sentinel narrowed.

**It did not converge, and its own ADR says so in those words.** Fourteen
failures were found across eight review rounds — four of them coverage gaps
where the check never looked at all — and **every one of them reported clean
rather than erroring.** The count of known blind spots shrank each round and the
rate of discovery did not. Two more (app feature server actions outside
`src/data/live/**`; a handler whose transaction is opened inside a helper) were
recorded on #3132 and never closed.

That is the property that makes a green mandatory check worse than no check: it
turns "nobody has verified this" into "CI says it is fine". The residual was
structural rather than a backlog — naming a table needs module resolution and
dataflow, reaching a capability needs a closed set of wrapper shapes that
nothing bounds, deciding which branch runs needs path sensitivity plus
interprocedural constant propagation — and one of the fourteen was worse than a
false negative: it **failed CI on a correct org-level read and recommended an
RLS bypass**, which is the defect the check exists to prevent.

The property the check was trying to prove is a negative about every call site.
It is far better enforced where the table is already known.

## Decision

### 1. An org-only scope carries a workspace GUC that is not a uuid

`withTenantDb` and `withRepeatableReadTenantDb` translate
`ORG_ONLY_WORKSPACE_ID` into `ORG_ONLY_WORKSPACE_GUC` —
`"org-only-scope-names-no-workspace"` — when setting
`app.current_workspace_id`. Every policy that casts the GUC then raises
SQLSTATE 22P02, `invalid input syntax for type uuid`, instead of quietly
narrowing.

The sentinel itself does not move and does not change. ADR-068 put it in
`packages/oxagen/src/types.ts` because `apps/app/src/**` may not import
`@oxagen/tenancy`, and the scope still carries the nil uuid so
`runInTenantScope`'s uuid guard is unaffected. The translation happens at the
one seam that writes the GUC, in one function, so it cannot be present in one
wrapper and missing in the next.

The marker is prose on purpose. Postgres puts the offending value verbatim into
the error, so the failure reads `invalid input syntax for type uuid:
"org-only-scope-names-no-workspace"` and names its own cause with no lookup.
`isOrgOnlyWorkspaceReadRefusal` matches SQLSTATE **and** the marker text,
because a malformed uuid from a path param raises the same SQLSTATE and calling
that "an org-only read of a workspace-scoped table" would be a second wrong
answer dressed as a diagnosis.

### 2. The refusal is raised while the statement is planned

This was measured, not assumed, and it is the most useful thing to know about
the mechanism. Postgres folds stable functions while estimating selectivity, so
`nullif(current_setting(...), '')::uuid` is evaluated **once, at plan time**,
before a single row is considered.

Three consequences, each witnessed in
`packages/database/integration/org-only-sentinel-refusal.test.ts`:

- **`EXPLAIN` raises.** There is no way to ask the planner about the statement
  without getting the refusal.
- **It does not depend on a hidden row being scanned.** An organisation that
  owns no rows raises. A `LIMIT` that would have stopped before reaching a
  workspace-scoped row raises. A row-time check would have let both through
  with a short answer, which is the exact failure being removed.
- **`app.rls_bypass = 'on'` does not suppress it,** because the cast is folded
  before the bypass disjunct is ever evaluated. Bypassed work therefore must not
  carry this marker. `withSystemDb` sets no workspace GUC at all, which is why
  it is unaffected, and ADR-054's migration connection does not either.

### 3. `withOrgDb` is the organisation-wide read seam

ADR-074 recorded a missing seam: `withTenantDb` is plane-aware and demands a
workspace, `withSystemDb` needs no workspace but always opens the shared-plane
singleton with RLS off. An organisation-wide aggregate over a tenant table had
no correct home, so it was written as `withSystemDb` plus a hand-written
`eq(table.orgId, orgId)` fence.

`withOrgDb` resolves the organisation's plane and calls `assertDataPlaneUsable`
exactly as `withTenantDb` does, sets `app.current_org_id`, leaves
`app.current_workspace_id` **empty** — `nullif('', '')::uuid` is NULL, which
casts cleanly, where the marker would raise at plan time whatever disjunct stood
in front of it — and sets `app.org_wide = 'on'`.

The generator emits that GUC as the whole predicate of a **separate `FOR SELECT`
policy**, `tenant_org_wide_read`, and emits it nowhere inside `tenant_isolation`:

| class | `tenant_isolation` USING (the `app.rls_bypass` disjunct omitted) | `tenant_org_wide_read` (`FOR SELECT`) |
|---|---|---|
| `org_only` | `org_id = ORG` | — |
| `org_or_global` | `org_id IS NULL OR org_id = ORG` | — |
| `workspace_nullable` | `org_id = ORG AND (ws IS NULL OR ws = WS)` | `ORG_WIDE AND org_id = ORG` |
| `standard` | `org_id = ORG AND ws = WS` | `ORG_WIDE AND org_id = ORG` |
| `workspace_only` | `workspace_id = WS` | — |

**The separation is the mechanism, and the first shape of this change did not
have it.** `app.org_wide` was originally a disjunct inside `tenant_isolation`'s
USING. A USING clause is not a read filter: Postgres applies it to the OLD rows
of an `UPDATE` and of a `DELETE` as well as to a `SELECT`, and `WITH CHECK` does
not run for a `DELETE` at all. So widening USING to the organisation widened
**deletion** to the organisation — any `withOrgDb` callback could delete every
workspace-scoped row in the org — and on a `workspace_nullable` table it also
let an `UPDATE` move a workspace row to `workspace_id = NULL`, where the
unchanged `WITH CHECK` then admitted it. A seam documented as a read-only
widening was a destructive one, and no `WITH CHECK` could have compensated.

Permissive policies are OR'd **within** a command type and AND'd **across** them.
A `FOR SELECT` policy therefore widens reads and cannot reach the old-row test
of an `UPDATE` or a `DELETE`: the destructive path cannot *see* the widened row
set, rather than being trusted not to touch it. `tenant_isolation`'s USING is
now byte-for-byte what it was before this ADR, which is also what keeps the
org-only refusal intact — it still casts the workspace GUC, so the marker still
raises 22P02 at plan time.

Five properties follow, and the database enforces each of them rather than the
caller:

- **The org fence stays with the database.** A query inside `withOrgDb` that
  forgets `eq(orgId)` still cannot see another organisation's rows. That is the
  whole argument for this over `withSystemDb` + a fence: the fence is one edit
  away from being dropped, and a dropped fence there is a cross-tenant read.
- **Reads widen; writes are judged by the unchanged WITH CHECK.** `app.org_wide`
  is absent from every WITH CHECK, and the workspace GUC is empty, so the only
  rows this seam can land are ones whose own `workspace_id` is NULL on a
  `workspace_nullable` table — which is what `change_org_member_role` writes. A
  row naming a workspace is refused 42501.
- **The widening does not reach `UPDATE` or `DELETE` at all.** Because the
  org-wide predicate lives in a `FOR SELECT` policy, the rows an `UPDATE` may
  touch and the rows a `DELETE` may destroy are still the ones
  `tenant_isolation` admits: this workspace's, plus the workspace-less rows on a
  `workspace_nullable` table. `org.member_role.change` and the `org` branch of
  `router.policy.set` write only that second kind, so both keep working. The
  witness is `integration/org-only-sentinel-refusal.test.ts`, which runs the
  real `DELETE` against the real policies and reads the row count — a reading of
  `pg_policies` tells you how a policy is spelled, not that a row was refused.
- **A conversion to `withOrgDb` cannot change database.** It resolves the same
  plane `withTenantDb` would and asserts the binding the same way. This closes,
  by construction, the coverage gap ADR-074 recorded as unclosable at the static
  layer: a `withTenantDb` → `withSystemDb` conversion silently drops
  `resolveDataPlane` and `assertDataPlaneUsable`, and that is how #3122's own
  data-plane regression got in with the checker green over it.
- **`workspace_only` gets no org-wide mode.** A table with a `workspace_id` and
  no `org_id` has no org column for the fence to hold, so widening it would open
  it to every tenant. It reads empty inside `withOrgDb`. That is derived from the
  class, not from a list of table names: reach such a table through the
  org-scoped parent it hangs off.

`app.org_wide` fails closed. `current_setting('app.org_wide', true) = 'on'` is
false when the GUC is absent, and `withTenantDb` pins it to `'off'` explicitly
so a nested call cannot inherit a caller's widening.

**Addendum, 2026-09-26 (#3941): the same read inside an open transaction.** A
`withOrgDb` called from inside a `withTenantDb` callback holds one pool
connection while it waits for a second, and enough concurrent callers exhaust
the pool waiting on each other. The Tacho policy bundle is built inside the
host's tenant transaction on every poll and ingest batch, and it needs the
repositories every workspace in the organisation bound. So
`withTransactionOrgWideRead(tx, fn)` sets `app.org_wide = 'on'` in a savepoint
on the caller's connection, runs `fn`, and restores the previous value. It
leaves the org, workspace and bypass GUCs as the caller set them. Every
property above holds, because the policies enforce them: the widening is the
`FOR SELECT` policy alone, so a write inside `fn` is judged by the unchanged
`tenant_isolation` and `WITH CHECK`. A throw rolls the savepoint back, and the
setting with it.

### 4. The reads that were correct under the sentinel move to `withOrgDb`

A read that ran under an org-only scope was either already broken — a `standard`
or `workspace_only` table answering emptily — or correct because its own
predicates said what RLS was restating. The first kind now raises, which is the
point. The second kind would have raised too, and that would have been an
outage, so it converts:

| site | tables | why it was correct, and still is |
|---|---|---|
| `packages/iam/src/fetch-authz.ts` | `iam.principals`, `iam.principal_role_assignments` (`workspace_nullable`), `auth.api_keys` (`standard`) | runs on EVERY `invoke()`, org-level surfaces included. The PRA query carries `workspace_id IS NULL OR workspace_id = <ctx>` itself; `principals` is matched on (org, parent_user_id, kind='human'), which a workspace-scoped agent principal cannot satisfy; `api_keys` on the key's own id |
| `packages/iam/src/org-role.ts` — `resolveActorOrgRoles` | the same IAM pair | pins `workspace_id IS NULL` for an org scope |
| `packages/iam/src/org-role.ts` — `resolveActorWorkspaceRoles` | the same | `assertOrgRole` calls it with the sentinel whenever the required set names a workspace role, and an org-only ctx carries the sentinel rather than nothing. `workspace_id = <sentinel>` matches no assignment, which is the right answer, and it is the query that says so |
| `packages/iam/src/org-role.ts` — `resolveActingUserId` | `auth.api_keys` | **this one was NOT correct.** `standard` under the sentinel answered emptily, so every API-key call on an org-level surface resolved to no principal and was refused `no_principal`. An empty result and an unknown key were the same answer. Fixed by the conversion |
| `packages/handlers/src/org.member_role.change.ts` | the IAM pair | every predicate already pins `workspace_id IS NULL`, and the rows it writes carry `workspace_id` NULL, which the unchanged WITH CHECK admits |
| `packages/handlers/src/router.policy.set.ts` — the `org` branch | `workspace.routing_policy` (`workspace_nullable`) | the org-level default row is the one whose `workspace_id` is NULL. The `workspace` branch keeps `withTenantDb`, and must: `withOrgDb` leaves the workspace GUC empty, so a row naming a workspace fails WITH CHECK with 42501. The seam follows the scope, in one expression, and the unit suite asserts each branch does NOT use the other's |

Every one of those tables is on the shared plane under ADR-042 §2, and
`withOrgDb` resolves the plane anyway, so the ADR-074 obligation to state which
plane a converted read is on is satisfied by the seam rather than by a comment.

### 5. `check-org-sentinel-reads.mjs` is deleted, with its baseline and its CI step

The script, `org-sentinel-reads-baseline.json`, its unit suite, the
`check:org-sentinel-reads` package script, the `gate` and `gate:full` entries and
the `checks` job step are gone. The pipeline carries a comment where the step
stood saying why, so the absence reads as a decision rather than an omission.

The baseline's only live entry went with it: an `acknowledged` false positive on
`list_members`, which the check reported because it pools the tables of every
`withTenantDb` region in a handler and cannot tell that the workspace branch
never runs at org scope. The runtime has no equivalent, because it judges the
statement that actually executes.

## What the new mechanism covers, and what it does not

The check retires against evidence, not against a verdict, and "it does not
converge" is not the same as "it catches nothing". So this is stated as coverage
against coverage.

**What the check's subject was:** a Postgres read issued under a
sentinel-carrying tenant scope. Its three passes were three ways of *finding*
such a read in the source — co-located `runInTenantScope`, the `apps/app`
`kernelRead` seam, and a sentinel ctx handed to `invoke()`. All three end in the
same place, because every tenant Postgres access in this repo goes through
`withTenantDb` or `withRepeatableReadTenantDb`: raw `db()` is banned by
`no-restricted-imports` in `eslint.tenancy-seams.mjs`, on the barrel and on the
`@oxagen/database/client` subpath, in every package and every app.

So the refusal covers **the whole of the check's subject and does not depend on
finding anything**. It also covers what the check's four residual axes could
not: an aliased or destructured table binding, a table imported straight from a
schema module or passed as a parameter, a table chosen at runtime, a query in a
helper any number of hops away, a handler reached through an eighth wrapper
shape nobody has written yet, and a branch whose reachability needs constant
propagation to decide. None of those are questions the database has to answer.

**What it does not cover**, stated so nobody reads the refusal as a proof of
more than it is:

- **`withSystemDb`.** It sets no workspace GUC, so nothing raises there, and an
  org-wide read inside it is fenced by application code alone. That is unchanged
  by this ADR, and it is the reason `withOrgDb` exists — to give those reads a
  seam where the fence is the database's again. Converting the remaining
  `withSystemDb` org-wide reads is follow-on work, not a regression this
  introduces.
- **Tables with no `tenant_isolation` policy** — `auth.users`,
  `org.organizations`, `billing.plans` and the rest of the platform-global rows.
  RLS is not what isolates them. This is the one way the refusal could report a
  false clean, so it is worth saying exactly what stops it:
  `manifest-coverage.test.ts` reads `information_schema` on a real migrated
  Postgres and fails when a table carrying `org_id` — or `workspace_id` without
  `org_id` — is absent from `POLICY_MANIFEST`, when a manifest table lacks
  `FORCE ROW LEVEL SECURITY`, or when it carries no `tenant_isolation` policy.
  Both of its allowlists are empty today, and an entry can only be added by
  hand with a written reason. So a new tenant table cannot fall outside the
  refusal quietly; someone has to write down that it should.
- **Neo4j and ClickHouse.** Their scoping is a separate seam, and neither reads
  this GUC.
- **A read at a REAL workspace scope that should have been org-wide.** The
  refusal is about the org-only scope. A page that narrows to one workspace when
  it meant the organisation is a different defect and nothing here catches it.
- **CI timing.** This is the one thing the check did that the runtime does not.
  A static check fails on the pull request; a runtime refusal fails when the
  code runs. The trade is deliberate — a check that reports clean on what it
  cannot read is not early warning, it is a false all-clear — and the
  `rls-integration` corpus is what moves the evidence back to CI for the part
  that can be decided there.

### A mock that substitutes one seam substitutes all of them

Converting `fetch-authz` and the role lookups turned 555 unit tests red across
`@oxagen/handlers` and `@oxagen/agent` at once, and the single cause is worth
recording because it is not what it first looked like.

Every one of those suites writes

```ts
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, withTenantDb: mocks.withTenantDb };
});
```

and the spread leaves `withOrgDb` as the **real** function. `withOrgDb` calls
`requireScope()` — and so has `withTenantDb`, on its first line, since it was
written. So the org-wide seam is not stricter than the one it sits beside; it
was simply unmocked. The suites establish no tenant scope because they replaced
the seam that would have demanded one, and a role gate that moved to the
unmocked seam found that out.

**The fix is not to let `withOrgDb` proceed without a scope.** A transaction
seam that opens without a tenant scope is the class of defect this ADR exists to
remove, and making the organisation-wide seam lenient to satisfy a harness would
leave it weaker than `withTenantDb` standing next to it — while the production
path the leniency would serve is the one that matters most, since `fetch-authz`
runs on every `invoke()`. The guarantee is asserted in
`packages/database/src/tenant.test.ts`, the one suite that does not mock the
seam: `withOrgDb` with no scope rejects.

The fix is that the mock covers both, aliased to **one identity**:

```ts
const dbMock = { ...real, withTenantDb: mocks.withTenantDb };
return { ...dbMock, withOrgDb: dbMock.withTenantDb };
```

Binding first rather than duplicating the initializer is load-bearing.
`withTenantDb: vi.fn()` and `withTenantDb: async (fn) => …` evaluate to a fresh
value each time, so copying the text would give the two seams two different
functions — and `api.key.create.test.ts` has a case named *"withTenantDb is
called twice: once for role resolution, once for insert"* that would then see
one. The alias keeps exactly the behaviour those suites had before the role gate
moved.

`tools/scripts/codemod-db-mock-org-seam.mjs` applied it to 252 factories and
doubles as `pnpm check:db-mock-seams`, chained into `check:contracts` so it runs
in `pnpm gate`, on pre-push and in CI. That check is a syntactic question about
one object literal — decidable from the parse, with no module resolution,
dataflow or path sensitivity — which is why it is worth having where the check
this ADR retires was not: a mock it misses raises loudly the first time that
test authorizes, rather than answering something quietly wrong.

## Consequences

- `packages/database/integration/org-only-sentinel-refusal.test.ts` drives its
  assertions off `POLICY_MANIFEST` rather than off a sample: 84
  `standard` / `workspace_nullable` / `workspace_only` tables must refuse an
  org-only read, 26 `org_only` / `org_or_global` tables must still answer it. A
  table added to the manifest is covered the moment it is added, and a table
  whose class changes moves between the halves by itself. It also asserts that
  every live `tenant_isolation` policy naming the workspace GUC casts it, read
  from `pg_policies` rather than from the generator, so a policy hand-written
  past the generator is caught too.
- A read that was silently short is now a 500. Every such site was already
  returning the wrong answer; this makes the wrongness arrive as an error
  instead of as data. That is the trade the whole change is, and it is worth
  saying plainly rather than describing the change as a pure improvement.
- `20260917120000_org_wide_read_mode.sql` regenerates all 110 manifest
  `tenant_isolation` policies and adds `tenant_org_wide_read` (`FOR SELECT`) to
  the 83 `standard` and `workspace_nullable` tables. It `DROP POLICY IF EXISTS`
  both names on every table, so a class that loses its widening loses the policy
  instead of keeping a stale one.
  Three `ingestion.*` tables carry a transitive `tenant_isolation` policy —
  `EXISTS (SELECT 1 FROM ingestion.source_connections …)` — that the generator
  does not emit and this migration does not touch. They need no change: the
  subquery is itself subject to `source_connections`' policy for a non-superuser,
  so both the refusal and the org-wide widening reach them through their parent.
- `org-only-scope-writes.test.ts` keeps its two write refusals and they changed
  SQLSTATE, 42501 to 22P02. Its `workspace_nullable` block used to assert that a
  read answered "1" of two holders; it now asserts the refusal, and the old
  behaviour is kept as a named test under the nil uuid so a future edit that puts
  a uuid back in the GUC brings the under-read back with a failing assertion
  rather than quietly.
- ADR-074 stays, with its decision 3 superseded. Its Context is the record of
  what the defect cost, its "two things RLS was also doing" is the reason a
  conversion is never just a seam swap, and its account of the check's failure is
  the argument for this ADR. A reader who wants to know why a static check was
  not simply improved should read that section, not this one.
