/**
 * RLS Tenant Isolation Proof
 *
 * This is the ONE place tenant isolation is asserted end-to-end against a real
 * migrated Postgres database. It seeds two orgs (A/B) each with a workspace
 * and representative rows, then proves — using UNFILTERED queries — that the
 * RLS policies enforce the boundary.
 *
 * Five assertions (each its own it-block):
 *   G1  — unfiltered read returns only the active org's rows
 *   G2  — explicit WHERE on other org returns 0 rows
 *   G3  — WITH CHECK blocks cross-org insert
 *   G4  — no GUC + bypass off → 0 rows (fail-closed)
 *   G5  — workspace_only proof: workspace_users filtered by workspace GUC alone
 *
 * NOTE ON SUPERUSER AND RLS: PostgreSQL superusers bypass RLS unconditionally
 * even when FORCE ROW LEVEL SECURITY is set. In production, the application
 * connects as a non-superuser role. This suite creates a non-superuser role
 * `rls_test_role` and uses `SET ROLE rls_test_role` within each isolation
 * transaction so the RLS policies are evaluated. The superuser session is used
 * only for seeding, cleanup, and role management where bypass-by-default is
 * the desired behaviour.
 *
 * CI: rls-integration job (TENANT_RLS_ENFORCEMENT_ENABLED=true, clean DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

// Single shared superuser connection. We use SET ROLE inside transactions to
// drop to a non-superuser context for the isolation assertions.
const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

// ---------------------------------------------------------------------------
// Deterministic UUIDs — same values in beforeAll/afterAll for safe cleanup.
// ---------------------------------------------------------------------------

const ORG_A = "00000000-0000-0000-0001-000000000001";
const ORG_B = "00000000-0000-0000-0001-000000000002";
const WS_A = "00000000-0000-0000-0002-000000000001";
const WS_B = "00000000-0000-0000-0002-000000000002";
// Sentinel user UUID for chat.conversations.user_id NOT NULL.
const USER_SENTINEL = "00000000-0000-0000-0099-000000000001";

// The non-superuser role used for isolation assertions. Must not be a
// superuser or replication role. Created in beforeAll, dropped in afterAll.
const APP_ROLE = "rls_test_app_role";

// ---------------------------------------------------------------------------
// Seed + setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // 1. Create a non-superuser role and grant it SELECT / INSERT on the tables
  //    used in the isolation assertions.
  // Use sql.unsafe() for DDL that can't use parameterized queries.
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE "${APP_ROLE}" NOLOGIN NOSUPERUSER;
      END IF;
    END$$
  `);

  // Grant privileges so the role can see tables (but RLS still gates rows).
  await sql.unsafe(`GRANT USAGE ON SCHEMA chat TO "${APP_ROLE}"`);
  await sql.unsafe(
    `GRANT SELECT, INSERT ON chat.conversations TO "${APP_ROLE}"`,
  );
  await sql.unsafe(`GRANT USAGE ON SCHEMA workspace TO "${APP_ROLE}"`);
  await sql.unsafe(
    `GRANT SELECT ON workspace.workspace_users TO "${APP_ROLE}"`,
  );

  // 2. Seed minimal fixture rows. All inserts run as superuser (bypass on).
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;

    // org.organizations — NOT NULL: id, public_id, name, slug, namespace,
    // plan_type, status, type. namespace is citext, globally unique, and must
    // match ^[a-z0-9]{2,6}$ (organizations_namespace_check).
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG_A}, 'rls_test_org_a', 'RLS Org A', 'rls-org-a', 'rlsa', 'free', 'active', 'business'),
        (${ORG_B}, 'rls_test_org_b', 'RLS Org B', 'rls-org-b', 'rlsb', 'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;

    // workspace.workspaces — NOT NULL: id, public_id, org_id, name, slug,
    // namespace. namespace is citext, unique per org, and must match
    // ^[a-z0-9]{2,6}$ (workspaces_namespace_check).
    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'rls_test_ws_a', ${ORG_A}, 'RLS WS A', 'rls-ws-a', 'wsa'),
        (${WS_B}, 'rls_test_ws_b', ${ORG_B}, 'RLS WS B', 'rls-ws-b', 'wsb')
      ON CONFLICT (id) DO NOTHING
    `;

    // chat.conversations — NOT NULL: id, public_id, org_id, workspace_id,
    // user_id, status. title is nullable but supplied for readability.
    await tx`
      INSERT INTO chat.conversations
        (id, public_id, org_id, workspace_id, user_id, status, title)
      VALUES
        (gen_random_uuid(), 'rls_test_cnv_a', ${ORG_A}, ${WS_A}, ${USER_SENTINEL}, 'active', 'A conv'),
        (gen_random_uuid(), 'rls_test_cnv_b', ${ORG_B}, ${WS_B}, ${USER_SENTINEL}, 'active', 'B conv')
      ON CONFLICT DO NOTHING
    `;

    // workspace.workspace_users — NOT NULL: id, public_id, workspace_id,
    // user_id, role, joined_at. permissions defaults to '{}'.
    await tx`
      INSERT INTO workspace.workspace_users
        (id, public_id, workspace_id, user_id, role, joined_at)
      VALUES
        (gen_random_uuid(), 'rls_test_wsu_a', ${WS_A}, ${USER_SENTINEL}, 'member', now()),
        (gen_random_uuid(), 'rls_test_wsu_b', ${WS_B}, ${USER_SENTINEL}, 'member', now())
      ON CONFLICT DO NOTHING
    `;
  });
});

afterAll(async () => {
  // Clean up seed rows as superuser (bypass on).
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM workspace.workspace_users WHERE public_id IN ('rls_test_wsu_a', 'rls_test_wsu_b')`;
    await tx`DELETE FROM chat.conversations WHERE public_id IN ('rls_test_cnv_a', 'rls_test_cnv_b')`;
    await tx`DELETE FROM workspace.workspaces WHERE id IN (${WS_A}, ${WS_B})`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
  });

  // Drop the test role (best-effort; revoking grants first).
  await sql
    .unsafe(`REVOKE ALL ON chat.conversations FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE ALL ON workspace.workspace_users FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA chat FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA workspace FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);

  await sql.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// Helper: run a callback inside a transaction where:
//   • SET ROLE drops privileges to the non-superuser app role (enabling RLS)
//   • GUCs are set for org/workspace scope
//   • bypass=off so policies are live
//
// Using SET ROLE within a transaction is the standard Postgres technique for
// testing RLS without a separate connection — the original role is restored
// automatically at transaction end (RESET ROLE is implicit on COMMIT/ROLLBACK).
// ---------------------------------------------------------------------------

async function asTenant<T>(
  orgId: string,
  workspaceId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // postgres.begin<T>() returns Promise<UnwrapPromiseArray<T>>; for array T
  // UnwrapPromiseArray<T> = T, so the cast is safe.
  return sql.begin(async (tx) => {
    // Drop to non-superuser so RLS is evaluated.
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    // Set tenant GUCs within this transaction scope (third arg true = local).
    await tx`
      SELECT
        set_config('app.current_org_id',      ${orgId},      true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass',           'off',         true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

// ---------------------------------------------------------------------------
// Isolation assertions
// ---------------------------------------------------------------------------

describe("RLS tenant isolation (policies enforced, non-superuser via SET ROLE, bypass=off)", () => {
  // G1 — The headline proof. No WHERE clause; RLS is the only filter.
  // Confirms the policy actually restricts rather than being a no-op.
  it("G1: UNFILTERED SELECT returns only active org's rows", async () => {
    const rows = await asTenant(
      ORG_A,
      WS_A,
      (tx) => tx<{ org_id: string }[]>`SELECT org_id FROM chat.conversations`,
    );

    expect(rows.length, "Expected at least one row for Org A").toBeGreaterThan(
      0,
    );
    expect(
      rows.every((r) => r.org_id === ORG_A),
      `All returned rows must belong to ORG_A; got: ${JSON.stringify(rows.map((r) => r.org_id))}`,
    ).toBe(true);
  });

  // G2 — Even an explicit WHERE for the other tenant returns nothing; the
  // policy's USING predicate filters it before the WHERE clause is evaluated.
  it("G2: explicit WHERE for ORG_B under ORG_A scope returns 0 rows", async () => {
    const rows = await asTenant(
      ORG_A,
      WS_A,
      (tx) => tx`SELECT 1 FROM chat.conversations WHERE org_id = ${ORG_B}`,
    );
    expect(rows.length).toBe(0);
  });

  // G3 — WITH CHECK. The policy's WITH CHECK clause must reject any INSERT
  // where the org_id/workspace_id don't match the GUC values.
  it("G3: WITH CHECK blocks inserting a cross-tenant row", async () => {
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) =>
          tx`
          INSERT INTO chat.conversations
            (id, public_id, org_id, workspace_id, user_id, status, title)
          VALUES
            (gen_random_uuid(), 'rls_test_evil', ${ORG_B}, ${WS_B}, ${USER_SENTINEL}, 'active', 'evil')
        `,
      ),
    ).rejects.toThrow();
  });

  // G4 — Fail-closed. With bypass=off and no org/workspace GUC set, the
  // policy predicate evaluates to FALSE for every row → 0 rows returned.
  it("G4: no org GUC set with bypass=off returns 0 rows (fail-closed)", async () => {
    const rows = await sql.begin(async (tx) => {
      // Drop to non-superuser so RLS is evaluated.
      await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
      // Explicitly enforce bypass off and clear any tenant GUCs.
      // nullif in the policy treats '' as NULL → no match → 0 rows.
      await tx`
        SELECT
          set_config('app.rls_bypass',           'off', true),
          set_config('app.current_org_id',        '',   true),
          set_config('app.current_workspace_id',  '',   true)
      `;
      return tx`SELECT 1 AS n FROM chat.conversations`;
    });
    expect(rows.length).toBe(0);
  });

  // G5 — workspace_only proof. workspace.workspace_users has workspace_id but
  // NO org_id; its policy is keyed solely on app.current_workspace_id.
  // An unfiltered SELECT under WS_A must return only WS_A membership rows.
  it("G5: workspace_only policy filters workspace.workspace_users by workspace GUC alone", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
      await tx`
        SELECT
          set_config('app.current_workspace_id', ${WS_A}, true),
          set_config('app.rls_bypass',           'off',   true)
      `;
      return tx<
        { workspace_id: string }[]
      >`SELECT workspace_id FROM workspace.workspace_users`;
    });

    expect(
      rows.length,
      "Expected at least one workspace_users row for WS_A",
    ).toBeGreaterThan(0);
    expect(
      rows.every((r) => r.workspace_id === WS_A),
      `All rows must belong to WS_A; got: ${JSON.stringify(rows.map((r) => r.workspace_id))}`,
    ).toBe(true);
  });
});
