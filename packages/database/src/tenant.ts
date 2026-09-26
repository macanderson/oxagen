import { sql } from "drizzle-orm";
import {
  assertDataPlaneUsable,
  requireScope,
  resolveDataPlane,
  type PostgresPlaneConfig,
} from "@oxagen/tenancy";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import { isProductionRuntime } from "@oxagen/config/env";
import { db, type Database } from "./client";
import { runOnPlane } from "./column-probe";
import { dedicatedDb } from "./data-plane-pool";
import { rlsEnforced } from "./tenant-flag";
import { recordIfUnscoped } from "./unscoped-meter";

/** The transaction handle Drizzle hands to a `.transaction(cb)` callback. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * What `app.current_workspace_id` is set to when the scope in force is
 * organisation-only — that is, when `workspaceId` is `ORG_ONLY_WORKSPACE_ID`
 * (ADR-068's nil-uuid sentinel).
 *
 * It is DELIBERATELY NOT A UUID. Every generated `tenant_isolation` policy
 * reads the GUC as `nullif(current_setting('app.current_workspace_id', true),
 * '')::uuid`, so a value that is not a uuid makes that policy RAISE — SQLSTATE
 * 22P02, `invalid input syntax for type uuid` — instead of quietly narrowing.
 *
 * That is the whole of ADR-086. Before it, an org-only scope carried the nil
 * uuid into the GUC and Postgres HID rows rather than refusing: a
 * `workspace_nullable` table answered with its `workspace_id IS NULL` rows
 * alone, a `standard` or `workspace_only` table answered with nothing, and in
 * both cases the caller got a short answer shaped exactly like a complete one.
 * A signed SOC 2 export came out missing every workspace-scoped security event
 * that way. ADR-074 tried to catch it by reading the source; eight blind spots
 * in eight review rounds, every one reporting clean, says that cannot be done.
 *
 * Three properties are worth knowing before changing this:
 *
 *  - **It refuses at PLAN time, not per row.** Postgres folds stable functions
 *    while estimating selectivity, so the cast runs once when the statement is
 *    planned. An `EXPLAIN` raises. A table with no matching rows raises. A
 *    `LIMIT` that would have stopped before reaching a hidden row raises. There
 *    is no query shape that slips past by touching nothing.
 *  - **`app.rls_bypass = 'on'` does NOT suppress it,** for the same reason —
 *    the cast is folded before the bypass disjunct is ever evaluated. Bypassed
 *    work therefore must not carry this marker; `withSystemDb` sets no
 *    workspace GUC at all, which is why it is unaffected.
 *  - **`org_only` tables are untouched.** Their policy never names the
 *    workspace GUC, so an org-level read of one answers in full, exactly as it
 *    did. That is most of the sentinel-scoped code in the tree.
 *
 * The value is prose on purpose: Postgres puts it verbatim into the error —
 * `invalid input syntax for type uuid:
 * "org-only-scope-names-no-workspace"` — so the failure names its own cause at
 * the point it happens, with no lookup.
 */
export const ORG_ONLY_WORKSPACE_GUC = "org-only-scope-names-no-workspace";

/**
 * The value `app.current_workspace_id` carries for a given scope.
 *
 * One function, used by every seam that opens a tenant transaction, so the
 * org-only translation cannot be present in one and missing in the next.
 */
function workspaceGuc(workspaceId: string): string {
  return workspaceId === ORG_ONLY_WORKSPACE_ID
    ? ORG_ONLY_WORKSPACE_GUC
    : workspaceId;
}

/**
 * True when `err`, or anything in its `.cause` chain, is the refusal above.
 *
 * Matches SQLSTATE 22P02 AND the marker text. 22P02 alone is not enough — a
 * caller passing a malformed uuid from a path param raises the same SQLSTATE,
 * and calling that "an org-only read of a workspace-scoped table" would be a
 * second wrong answer dressed as a diagnosis.
 */
export function isOrgOnlyWorkspaceReadRefusal(err: unknown): boolean {
  for (let cur: unknown = err, depth = 0; cur != null && depth < 5; depth++) {
    const e = cur as { code?: string; message?: string; cause?: unknown };
    if (
      e.code === "22P02" &&
      typeof e.message === "string" &&
      e.message.includes(ORG_ONLY_WORKSPACE_GUC)
    ) {
      return true;
    }
    cur = e.cause;
  }
  return false;
}

/**
 * Resolve which physical Postgres this organisation's tenant data lives on
 * (ADR-042). `shared` — the default and, until a customer buys a dedicated
 * plane, the only answer — returns the process singleton, so this is one
 * already-resolved promise and a branch on the hot path.
 *
 * Fail-closed: `assertDataPlaneUsable` throws `DataPlaneUnavailableError` for a
 * degraded or disabled plane instead of quietly using the shared singleton. A
 * fallback there would write one tenant's rows into the platform store that
 * tenant explicitly moved its data out of — the precise failure ADR-042 exists
 * to make impossible.
 */
/**
 * The probe cache key for a dedicated plane.
 *
 * `configDigest` identifies the physical database — it is what the pool keys
 * its connections on — so two organisations on the same dedicated plane share
 * a probe answer and two planes never do.
 *
 * It is `string | null`: the resolver returns null for a binding written
 * without one. `dedicated:${digest}` then mapped every such database to the
 * literal key `dedicated:null`, so two null-digest organisations on DIFFERENT
 * dedicated databases shared one answer — and a positive probe on the migrated
 * one would be kept for the life of the process and handed to the other,
 * dropping the compatibility projection against a database that still lacks
 * the column. That is the failure #3223 exists to prevent, reintroduced
 * through a null.
 *
 * So a missing digest keys per ORGANISATION, mirroring `data-plane-pool`'s
 * cache key and its reasoning exactly. It loses nothing but sharing: two orgs
 * on one plane probe once each rather than once between them. Correctness
 * first.
 */
export function dedicatedPlaneKey(
  orgId: string,
  configDigest: string | null | undefined,
): string {
  return configDigest == null
    ? `dedicated:org:${orgId}`
    : `dedicated:${configDigest}`;
}

async function tenantPlaneDb(
  orgId: string,
): Promise<{ database: Database; planeKey: string }> {
  const plane = await resolveDataPlane(orgId, "postgres");
  assertDataPlaneUsable(plane);
  if (plane.mode === "shared") return { database: db(), planeKey: "shared" };
  return {
    database: dedicatedDb({
      orgId,
      config: plane.config as PostgresPlaneConfig,
      configDigest: plane.configDigest,
    }),
    // The key the deploy-before-migrate probes file their answers under. It
    // comes from THIS resolution — the one that just chose the connection —
    // rather than from a second one made later by the probe, which could
    // disagree with it if the organisation were repointed in between (#3223).
    //
    // Falls back to the ORGANISATION when the digest is absent, mirroring
    // `data-plane-pool`'s cache key for the same reason and with the same
    // trade. `configDigest` is `string | null` — the resolver returns null for
    // a binding written without one — so `dedicated:${plane.configDigest}`
    // mapped every such database to the literal key `dedicated:null`. Two
    // null-digest organisations on DIFFERENT dedicated databases would then
    // share one answer, and a positive probe on the migrated one would be kept
    // for the life of the process and handed to the other, dropping the
    // compatibility projection against a database that still lacks the column.
    // That is the exact failure #3223 fixed, reintroduced through a null.
    //
    // Keying per organisation loses nothing but sharing: two orgs on the same
    // dedicated plane probe once each instead of once between them. Correctness
    // first, as the pool puts it.
    planeKey: dedicatedPlaneKey(orgId, plane.configDigest),
  };
}

/**
 * Run DB work in a tenant-scoped transaction. Sets the per-transaction GUCs
 * that the RLS policies read. When enforcement is OFF, also sets
 * app.rls_bypass='on' so policies don't yet filter (seeding window). When
 * enforcement is ON, sets app.rls_bypass='off' so policies enforce.
 *
 * The bypass GUC is always set ('on'/'off') so the policy expression always
 * evaluates a known value rather than defaulting on missing GUC.
 *
 * Keep the body focused — do not wrap long LLM/tool calls in one withTenantDb;
 * the transaction is held for the callback's lifetime.
 */
export async function withTenantDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const scope = requireScope();
  // The SAME GUC/RLS setup runs on a dedicated plane as on the shared one — a
  // customer-controlled endpoint is a second place the policies are enforced,
  // never an excuse to skip them.
  const { database, planeKey } = await tenantPlaneDb(scope.orgId);
  return tenantTransaction(database, planeKey, scope, fn);
}

/**
 * Run DB work in a tenant-scoped transaction on the SHARED plane, whatever
 * plane the organisation's tenant data lives on.
 *
 * ADR-042 §2 keeps platform tables (billing, IAM, auth, org) on the shared
 * plane, and ADR-134 settles a dedicated-plane organisation's model usage
 * there. `withTenantDb` cannot reach those rows for such an organisation,
 * because it opens its transaction on the dedicated plane. `withSystemDb`
 * reaches the shared plane but turns RLS off. This seam sets the same GUCs as
 * `withTenantDb`, so the `tenant_isolation` policies still fence every row,
 * and opens the transaction on the shared plane (#4315).
 *
 * It never consults the plane resolver, so a degraded or disabled dedicated
 * plane does not stop a platform write. Use it for platform tables only. A
 * tenant-data table read through it reads the shared plane, which for a
 * dedicated-plane organisation holds none of its data.
 */
export async function withSharedPlaneTenantDb<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return tenantTransaction(db(), "shared", requireScope(), fn);
}

/**
 * Open the transaction both tenant seams share: set the org, workspace,
 * org-wide and bypass GUCs the policies read, then run `fn`.
 */
function tenantTransaction<T>(
  database: Database,
  planeKey: string,
  scope: { orgId: string; workspaceId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const bypass = rlsEnforced() ? "off" : "on";
  return runOnPlane(planeKey, () =>
    database.transaction(async (tx) => {
      await tx.execute(sql`
      select
        set_config('app.current_org_id', ${scope.orgId}, true),
        set_config('app.current_workspace_id', ${workspaceGuc(scope.workspaceId)}, true),
        set_config('app.org_wide', 'off', true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
      return fn(tx);
    }),
  );
}

/**
 * Run an ORGANISATION-WIDE READ on the organisation's own data plane.
 *
 * This is the seam ADR-074 recorded as missing. `withTenantDb` is plane-aware
 * and demands a workspace; `withSystemDb` needs no workspace but always opens
 * the shared-plane singleton and turns RLS off entirely. An organisation-wide
 * aggregate over a tenant table — every workspace's runs, every workspace's
 * security events, the roles a principal holds anywhere in the org — had no
 * correct seam, so it was written as `withSystemDb` plus a hand-written
 * `eq(table.orgId, orgId)` fence. That trade is bad in both directions: the
 * read loses `resolveDataPlane` and `assertDataPlaneUsable`, so it can answer
 * correctly off the WRONG database; and the org boundary comes to rest on a
 * predicate a future edit can drop, with nothing but review between that
 * omission and a cross-tenant read.
 *
 * `withOrgDb` keeps both. It resolves the organisation's plane and asserts the
 * binding exactly as `withTenantDb` does, and it leaves RLS ON: the policies
 * still fence `org_id`, and `app.org_wide = 'on'` widens only the WORKSPACE
 * half of the READ. The database, not the caller, is still what keeps one
 * tenant out of another's rows.
 *
 * THE WIDENING IS STRUCTURALLY READ-ONLY. `app.org_wide` is the whole predicate
 * of a separate `FOR SELECT` policy, `tenant_org_wide_read`, and appears in no
 * clause of `tenant_isolation`. It has to be: a USING clause is not a read
 * filter — Postgres applies it to the OLD rows of an UPDATE and of a DELETE too,
 * and WITH CHECK never runs for a DELETE — so an org-wide disjunct inside
 * `tenant_isolation` would have let any callback here delete every
 * workspace-scoped row in the organisation, and move a `workspace_nullable` row
 * to `workspace_id = NULL` past the unchanged check. Permissive policies are
 * OR'd within a command type and AND'd across them, so a `FOR SELECT` policy
 * widens the read and cannot reach an UPDATE's or a DELETE's old-row test.
 *
 * Four properties, each of which the generated policies enforce rather than
 * this function:
 *
 *  - **Reads widen, writes are judged by the unchanged WITH CHECK.**
 *    `app.org_wide` is absent from every WITH CHECK, and the workspace GUC is
 *    empty here, so the only rows this seam can write are the ones whose own
 *    `workspace_id` is NULL — an org-wide role assignment on a
 *    `workspace_nullable` table. A row naming a workspace, or any row on a
 *    `standard` table, is refused with SQLSTATE 42501. Write those in the
 *    workspace's own scope through `withTenantDb`.
 *  - **UPDATE and DELETE see the unwidened row set.** The rows a statement here
 *    may modify or destroy are the ones `tenant_isolation` admits — this
 *    scope's workspace (empty), plus the workspace-less rows of a
 *    `workspace_nullable` table. A DELETE aimed at another workspace's row
 *    inside this organisation affects ZERO rows. `SELECT … FOR UPDATE` is
 *    narrowed the same way, which is right: a locking read is the first half of
 *    a write.
 *  - **The org fence is still the database's.** A row belonging to another
 *    organisation is invisible here for the same reason it is invisible in
 *    `withTenantDb`, and an omitted `eq(orgId)` predicate cannot change that.
 *  - **`workspace_only` tables get nothing.** A table with a `workspace_id`
 *    and no `org_id` — `workspace.workspace_users` is the only one in the
 *    manifest — has no org column for the fence to hold, so its policy carries
 *    no org-wide disjunct and it reads empty here. That is by construction, not
 *    by omission: reach such a table through the org-scoped parent it hangs
 *    off. This is the one under-read `withOrgDb` can still produce, and it is
 *    derivable from the table's class rather than from a list of names.
 *
 * Requires an active tenant scope, like `withTenantDb` — the scope is where the
 * organisation comes from. The workspace in that scope is ignored, which is the
 * point: a caller in a real workspace that asks for the organisation gets the
 * organisation.
 */
export async function withOrgDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const { orgId } = requireScope();
  const bypass = rlsEnforced() ? "off" : "on";
  const { database, planeKey } = await tenantPlaneDb(orgId);
  return runOnPlane(planeKey, () =>
    database.transaction(async (tx) => {
      // The workspace GUC is set to the EMPTY STRING, not to
      // ORG_ONLY_WORKSPACE_GUC. `nullif('', '')::uuid` is NULL, which casts
      // cleanly; the org-only marker would raise at plan time on every policy
      // that names the GUC, org-wide disjunct or not, because Postgres folds the
      // cast while estimating selectivity. Setting it explicitly rather than
      // leaving it inherited also means a `withOrgDb` nested inside an open
      // transaction cannot pick up the caller's workspace.
      await tx.execute(sql`
      select
        set_config('app.current_org_id', ${orgId}, true),
        set_config('app.current_workspace_id', '', true),
        set_config('app.org_wide', 'on', true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
      return fn(tx);
    }),
  );
}

/**
 * Re-point `app.current_workspace_id` on an ALREADY-OPEN tenant transaction.
 *
 * NARROW BY DESIGN — there is exactly one legitimate use: a transaction that
 * CREATES the workspace it then writes rows for. `withTenantDb` sets the GUCs
 * from the scope the caller was already in, and a workspace being created has
 * no scope to have been in: `create_workspace` runs under the caller's scope,
 * which for an org-only caller (`ORG_ONLY_WORKSPACE_ID`, ADR-068) names no
 * workspace at all. `workspace.workspaces` is `org_only` so the INSERT lands,
 * but every workspace-GUC-scoped table the bootstrap then writes —
 * `workspace.workspace_users` (workspace_only), `agent.agents` and
 * `environments.environments` (standard) — is refused by its
 * `tenant_isolation` WITH CHECK with SQLSTATE 42501. Re-pointing the GUC the
 * moment the row exists keeps the whole bootstrap in ONE transaction, which is
 * the property `workspace-bootstrap.ts` depends on: the workspace and
 * everything that makes it usable commit together or not at all.
 *
 * `set_config(..., true)` is transaction-local, so the new value rolls back
 * with the transaction like the original one did.
 *
 * Do NOT reach for this to "fix" a scope mismatch anywhere else. Every other
 * write whose target workspace differs from the ambient scope re-enters that
 * workspace's scope with `runInTenantScope` + `withTenantDb` (see
 * `workspace.archive` and `workspace.settings.write`), which keeps the
 * AsyncLocalStorage scope and the transaction's GUCs telling the same story.
 */
export async function setTransactionWorkspaceScope(
  tx: Tx,
  workspaceId: string,
): Promise<void> {
  await tx.execute(
    sql`select set_config('app.current_workspace_id', ${workspaceId}, true)`,
  );
}

/**
 * Write an org-owned row inside an existing mixed workspace/org transaction.
 * The org fence and bypass state remain unchanged. An empty workspace narrows
 * writes to workspace-less rows; it does not permit other workspace writes.
 * A savepoint restores transaction-local settings on callback failure, even
 * when SQL aborted the savepoint. Success restores the exact prior setting.
 * Callers must authorize the org mutation before entering this callback.
 */
export async function withTransactionOrgScope<T>(
  tx: Tx,
  fn: (orgTx: Tx) => Promise<T>,
): Promise<T> {
  return tx.transaction(async (orgTx) => {
    const [previous] = await orgTx.execute<{ workspace: string | null }>(
      sql`select current_setting('app.current_workspace_id', true) as workspace`,
    );
    await orgTx.execute(
      sql`select set_config('app.current_workspace_id', '', true)`,
    );
    const result = await fn(orgTx);
    await orgTx.execute(
      sql`select set_config('app.current_workspace_id', ${previous?.workspace ?? ""}, true)`,
    );
    return result;
  });
}

/**
 * Like `withTenantDb`, but the transaction runs at REPEATABLE READ.
 *
 * Narrow by design: this exists for ADMISSION-TIME AUTHORIZATION SNAPSHOT
 * CONSTRUCTION and nothing else (docs/specs/run-evidence-ingress). Building a
 * pinned grant ceiling means reading role assignments, role grants, principal
 * status, AND the deny-generation counters, then digesting the result. Under
 * READ COMMITTED each of those statements sees a different snapshot, so a grant
 * revoked mid-read can land in the ceiling while the generation bump that
 * should have invalidated it is also read — producing a snapshot that never
 * existed at any instant. REPEATABLE READ makes the whole ceiling and its
 * generation vector share one MVCC snapshot, which is exactly the property the
 * "later grants cannot expand an active run" rule depends on.
 *
 * Do NOT reach for this as a general-purpose stronger transaction: repeatable
 * read can fail with a serialization error (40001) that the caller must be
 * prepared to retry, and holding it across slow work amplifies that. Use
 * `withTenantDb` everywhere else.
 */
export async function withRepeatableReadTenantDb<T>(
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const { orgId, workspaceId } = requireScope();
  const bypass = rlsEnforced() ? "off" : "on";
  const { database, planeKey } = await tenantPlaneDb(orgId);
  return runOnPlane(planeKey, () =>
    database.transaction(async (tx) => {
      // Must be the first statement after BEGIN — Postgres rejects
      // SET TRANSACTION ISOLATION LEVEL once the transaction has read anything.
      await tx.execute(sql`set transaction isolation level repeatable read`);
      await tx.execute(sql`
      select
        set_config('app.current_org_id', ${orgId}, true),
        set_config('app.current_workspace_id', ${workspaceGuc(workspaceId)}, true),
        set_config('app.org_wide', 'off', true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
      return fn(tx);
    }),
  );
}

/**
 * Run DB work in a transaction with RLS DELIBERATELY BYPASSED
 * (app.rls_bypass='on'). This is the explicit, greppable escape hatch for the
 * narrow set of operations that legitimately cross (or precede) a tenant scope:
 *
 *  - identity resolution that must read tenant-policied tables BEFORE a scope
 *    exists (e.g. resolve an org from a slug/api-key, membership checks);
 *  - resolving an org from an external id on inbound webhooks (Stripe customer);
 *  - trusted cross-tenant system/cron jobs (e.g. nightly usage rollup);
 *  - bootstrap that creates a tenant's own root rows (org/workspace creation);
 *  - the security-event audit write, which must succeed even on a no-scope deny.
 *
 * This is NOT a shortcut for normal handlers. Those use withTenantDb so RLS
 * stays load-bearing. Unlike withTenantDb it requires NO active ALS scope.
 *
 * Nothing audits a call at runtime. The fence is a source check: every call
 * site carries a nearby `// tenancy:` comment that names the scope fence (the
 * orgId, userId, or workspaceId filter, the verified membership, the signed
 * webhook) or the global/system purpose. `pnpm check:system-db`
 * (tools/scripts/check-system-db-justifications.ts, part of check:contracts)
 * fails a new call without one, and its baseline of older exceptions may only
 * shrink. The check reads the comment's syntax only. Review must confirm that
 * the query actually applies the fence the comment names.
 */
export async function withSystemDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Count every withSystemDb call that runs with no active tenant scope. During
  // the seeding window (TENANT_RLS_ENFORCEMENT_ENABLED off) this counter is the
  // operator signal: when db.query.unscoped reads zero it is safe to flip
  // enforcement on. withSystemDb is the intentional RLS bypass, and these calls
  // still must be counted or the gate is permanently unreachable.
  recordIfUnscoped("withSystemDb");
  // ADR-042: withSystemDb ALWAYS uses the SHARED plane, deliberately, and never
  // consults resolveDataPlane. Three reasons, each sufficient on its own:
  //   1. Its callers are platform-level by definition — identity resolution,
  //      billing/IAM/auth/org tables, the security-event audit write, cron
  //      rollups. ADR-042 §2 keeps all of those on the shared plane; a
  //      dedicated plane carries tenant DATA only.
  //   2. It runs with NO active tenant scope in exactly the cases that matter
  //      (resolving an org from a slug or an api key, a Stripe webhook), so
  //      there is often no orgId to resolve a plane for.
  //   3. The data-plane resolver itself reads org.data_planes through this
  //      function. Making it plane-aware would be a cycle: to know which plane
  //      to read from, read the table that says which plane to read from.
  // `shared` published for the column probes, which is not an extra claim —
  // it is the same "ALWAYS the shared plane" the comment above states, said
  // where the probe can read it rather than left to be inferred (#3223).
  return runOnPlane("shared", () =>
    db().transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
      return fn(tx);
    }),
  );
}

/**
 * A system write to a table that lives on the ORGANISATION'S plane.
 *
 * `withSystemDb` always uses the shared plane, deliberately and for good
 * reasons (see its comment). Those reasons are about PLATFORM tables. A
 * tenant-data table on a dedicated plane is the case it does not cover: the
 * statement runs, matches nothing, and reports success, because the rows it
 * meant to touch are on another database entirely. That is how the Tacho
 * gateway observation was written — `tacho.hosts` is read through
 * `withTenantDb`, so for an organisation with a dedicated plane the write
 * landed on the shared plane, the observation never arrived, and every genuine
 * connected-app session stayed classified `observe`
 * (discussion_r4040617216).
 *
 * So this resolves the plane the way `withTenantDb` does, and bypasses RLS the
 * way `withSystemDb` does. It needs no ALS scope — the organisation is named
 * outright — which is the whole point: the callers are authorisation-time
 * paths that know their org and may have no scope yet.
 *
 * NARROW BY DESIGN. Reach for it only for a write to tenant-plane data from a
 * platform path, and say at the callsite why RLS is being bypassed. Anything
 * running inside a handler already has a scope and wants `withTenantDb`.
 */
export async function withOrgPlaneSystemDb<T>(
  orgId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  // Counted like `withSystemDb`: this is a deliberate RLS bypass, and leaving it
  // out of the meter would make the enforcement gate unreachable.
  recordIfUnscoped("withOrgPlaneSystemDb");
  const { database, planeKey } = await tenantPlaneDb(orgId);
  return runOnPlane(planeKey, () =>
    database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
      return fn(tx);
    }),
  );
}

/**
 * Fail-fast guard: a PRODUCTION runtime must never run with RLS enforcement
 * disabled. The env default is already fail-closed (ON in production), so the
 * only way to reach this state is an explicit TENANT_RLS_ENFORCEMENT_ENABLED=
 * "false" override in a production deployment — which would run every tenant
 * query with app.rls_bypass='on' and rely solely on the manual eq(orgId)
 * predicates, one forgotten filter away from a cross-tenant leak. Refuse to
 * boot. Synchronous (no DB round-trip) so it is cheap to call first at startup
 * and trivially unit-testable. No-op in dev/test/preview (the seeding window).
 */
export function assertRlsEnforcedInProduction(): void {
  if (isProductionRuntime() && !rlsEnforced()) {
    throw new Error(
      "[tenancy] Production runtime started with TENANT_RLS_ENFORCEMENT_ENABLED" +
        "=false — Row-Level Security is disabled, so tenant isolation depends " +
        "entirely on per-query org predicates and a single omission leaks data " +
        "across tenants. Unset the override (production defaults to enforced) or " +
        "set it to true. Refusing to start.",
    );
  }
}

/**
 * Fail-fast guard against the silent-bypass footgun: PostgreSQL superusers and
 * roles with BYPASSRLS ignore RLS unconditionally — even FORCE ROW LEVEL
 * SECURITY does not subject them to policies. If the app connects as such a
 * role while enforcement is on, every policy is dead weight and isolation
 * silently fails. Call this once at service startup; it throws (refuse to
 * start) when enforcement is enabled but the connection role can bypass RLS.
 * Always runs the production-enforcement guard first (independent of the
 * connection-role check), so every runtime that already calls this gets the
 * fail-closed-in-prod assertion for free. No-op while enforcement is off
 * (seeding window) beyond that guard.
 */
export async function assertRlsConnectionSafe(): Promise<void> {
  assertRlsEnforcedInProduction();
  if (!rlsEnforced()) return;
  const result = await db().execute(sql`
    select
      current_setting('is_superuser') as is_superuser,
      coalesce((select rolbypassrls from pg_roles where rolname = current_user), false) as bypassrls
  `);
  const rows = result as unknown as ReadonlyArray<{
    is_superuser: string;
    bypassrls: boolean;
  }>;
  const row = rows[0];
  if (row && (row.is_superuser === "on" || row.bypassrls === true)) {
    throw new Error(
      "[tenancy] TENANT_RLS_ENFORCEMENT_ENABLED=true but the database role " +
        `(${row.is_superuser === "on" ? "superuser" : "BYPASSRLS"}) bypasses ` +
        "Row-Level Security — tenant isolation would be silently ineffective. " +
        "Connect as a non-superuser, non-BYPASSRLS role (e.g. oxagen_app). " +
        "Refusing to start.",
    );
  }
}
