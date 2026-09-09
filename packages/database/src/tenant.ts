import { sql } from "drizzle-orm";
import {
  assertDataPlaneUsable,
  requireScope,
  resolveDataPlane,
  type PostgresPlaneConfig,
} from "@oxagen/tenancy";
import { isProductionRuntime } from "@oxagen/config/env";
import { db, type Database } from "./client";
import { dedicatedDb } from "./data-plane-pool";
import { rlsEnforced } from "./tenant-flag";
import { recordIfUnscoped } from "./unscoped-meter";

/** The transaction handle Drizzle hands to a `.transaction(cb)` callback. */
export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

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
async function tenantPlaneDb(orgId: string): Promise<Database> {
  const plane = await resolveDataPlane(orgId, "postgres");
  assertDataPlaneUsable(plane);
  if (plane.mode === "shared") return db();
  return dedicatedDb({
    orgId,
    config: plane.config as PostgresPlaneConfig,
    configDigest: plane.configDigest,
  });
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
  const { orgId, workspaceId } = requireScope();
  const bypass = rlsEnforced() ? "off" : "on";
  // The SAME GUC/RLS setup runs on a dedicated plane as on the shared one — a
  // customer-controlled endpoint is a second place the policies are enforced,
  // never an excuse to skip them.
  const database = await tenantPlaneDb(orgId);
  return database.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.current_org_id', ${orgId}, true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
    return fn(tx);
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
  const database = await tenantPlaneDb(orgId);
  return database.transaction(async (tx) => {
    // Must be the first statement after BEGIN — Postgres rejects
    // SET TRANSACTION ISOLATION LEVEL once the transaction has read anything.
    await tx.execute(sql`set transaction isolation level repeatable read`);
    await tx.execute(sql`
      select
        set_config('app.current_org_id', ${orgId}, true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass', ${bypass}, true)
    `);
    return fn(tx);
  });
}

/**
 * Run DB work in a transaction with RLS DELIBERATELY BYPASSED
 * (app.rls_bypass='on') — the explicit, audited, greppable escape hatch for the
 * narrow set of operations that legitimately cross (or precede) a tenant scope:
 *
 *  - identity resolution that must read tenant-policied tables BEFORE a scope
 *    exists (e.g. resolve an org from a slug/api-key, membership checks);
 *  - resolving an org from an external id on inbound webhooks (Stripe customer);
 *  - trusted cross-tenant system/cron jobs (e.g. nightly usage rollup);
 *  - bootstrap that creates a tenant's own root rows (org/workspace creation);
 *  - the security-event audit write, which must succeed even on a no-scope deny.
 *
 * This is NOT a shortcut for normal handlers — those use withTenantDb so RLS
 * stays load-bearing. Every use should be obvious from the callsite and the
 * surrounding comment. Unlike withTenantDb it requires NO active ALS scope.
 */
export async function withSystemDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Count every withSystemDb call that runs with no active tenant scope. During
  // the seeding window (TENANT_RLS_ENFORCEMENT_ENABLED off) this counter is the
  // operator signal: when db.query.unscoped reads zero it is safe to flip
  // enforcement on. withSystemDb is the intentional, audited RLS bypass — these
  // calls still must be counted or the gate is permanently unreachable.
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
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.rls_bypass', 'on', true)`);
    return fn(tx);
  });
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
