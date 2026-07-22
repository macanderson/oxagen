/**
 * Governed-run authorization foundation — live-database proof
 * (docs/specs/run-evidence-ingress/spec.md §"Security and retention rules",
 *  02-run-attempt-foundation-plan.md Task 2).
 *
 * The design claim under test is narrowing-only authority:
 *
 *   A1  tenant isolation on snapshots, denies, generations, and decisions
 *   A2  ACTUAL privileges — snapshots/decisions append-only; the generations
 *       table is SELECT-only for the application role so a cached allow can
 *       never be revived by resetting the counter
 *   A3  the security-definer trigger functions are not PUBLIC-executable
 *   A4  every authority-narrowing mutation bumps the generation IN THE SAME
 *       TRANSACTION (principal status, PRA, role, role grant, emergency deny)
 *   A5  the typed emergency-deny and decision constraints
 *
 * NOTE ON SUPERUSER: superusers bypass RLS and always pass privilege checks, so
 * the isolation assertions run under a non-superuser role via SET LOCAL ROLE,
 * exactly as integration/rls.test.ts does. Privilege assertions read the real
 * `oxagen_app` role's grants out of the catalog when that role exists.
 *
 * CI: rls-integration job (TENANT_RLS_ENFORCEMENT_ENABLED=true, clean DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database test:integration -- integration/authorization-foundation.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const ORG_A = "00000000-0000-0000-0021-000000000001";
const ORG_B = "00000000-0000-0000-0021-000000000002";
const WS_A = "00000000-0000-0000-0022-000000000001";
const WS_B = "00000000-0000-0000-0022-000000000002";

const HUMAN_PRINCIPAL = "00000000-0000-0000-0023-000000000001";
const AGENT_PRINCIPAL = "00000000-0000-0000-0023-000000000002";
const ROLE_ID = "00000000-0000-0000-0024-000000000001";
const SNAPSHOT_ID = "00000000-0000-0000-0025-000000000001";

const APP_ROLE = "azf_test_app_role";

const D = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const DIGEST_A = D("a");
const DIGEST_B = D("b");
const DIGEST_C = D("c");

const IMMUTABLE_TABLES: ReadonlyArray<string> = [
  "authorization_snapshots",
  "authorization_decisions",
];

// ---------------------------------------------------------------------------
// Seed + setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE "${APP_ROLE}" NOLOGIN NOSUPERUSER;
      END IF;
    END$$
  `);
  await sql.unsafe(`GRANT USAGE ON SCHEMA iam TO "${APP_ROLE}"`);
  for (const table of IMMUTABLE_TABLES) {
    await sql.unsafe(`GRANT SELECT, INSERT ON iam.${table} TO "${APP_ROLE}"`);
  }
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE ON iam.emergency_denies TO "${APP_ROLE}"`,
  );
  // Deliberately SELECT only — mirrors the migration's posture.
  await sql.unsafe(
    `GRANT SELECT ON iam.authorization_deny_generations TO "${APP_ROLE}"`,
  );

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;

    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG_A}, 'azf_test_org_a', 'AZF Org A', 'azf-org-a', 'azfa', 'free', 'active', 'business'),
        (${ORG_B}, 'azf_test_org_b', 'AZF Org B', 'azf-org-b', 'azfb', 'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'azf_test_ws_a', ${ORG_A}, 'AZF WS A', 'azf-ws-a', 'awsa'),
        (${WS_B}, 'azf_test_ws_b', ${ORG_B}, 'AZF WS B', 'azf-ws-b', 'awsb')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO iam.principals
        (id, public_id, org_id, workspace_id, kind, display_name, status)
      VALUES
        (${HUMAN_PRINCIPAL}, 'azf_test_prn_h', ${ORG_A}, ${WS_A}, 'human', 'AZF Human', 'active'),
        (${AGENT_PRINCIPAL}, 'azf_test_prn_a', ${ORG_A}, ${WS_A}, 'agent', 'AZF Agent', 'active')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO iam.roles (id, public_id, org_id, scope_kind, name)
      VALUES (${ROLE_ID}, 'azf_test_rol', ${ORG_A}, 'workspace', 'AZF Role')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO iam.authorization_snapshots
        (id, public_id, org_id, workspace_id, initiating_principal_id, agent_principal_id,
         grant_ceiling, grant_ceiling_digest, snapshot_digest,
         org_deny_generation, workspace_deny_generation)
      VALUES
        (${SNAPSHOT_ID}, 'ras_azf_test_1', ${ORG_A}, ${WS_A}, ${HUMAN_PRINCIPAL}, ${AGENT_PRINCIPAL},
         '{"assignments":[]}'::jsonb, ${DIGEST_A}, ${DIGEST_B}, 1, 1)
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM iam.authorization_decisions WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.authorization_snapshots WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.emergency_denies WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.role_grants WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.principal_role_assignments WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.roles WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.principals WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM iam.authorization_deny_generations WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM workspace.workspaces WHERE id IN (${WS_A}, ${WS_B})`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
  });

  for (const table of [
    ...IMMUTABLE_TABLES,
    "emergency_denies",
    "authorization_deny_generations",
  ]) {
    await sql
      .unsafe(`REVOKE ALL ON iam.${table} FROM "${APP_ROLE}"`)
      .catch(() => undefined);
  }
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA iam FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);

  await sql.end({ timeout: 5 });
});

async function asTenant<T>(
  orgId: string,
  workspaceId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${orgId},       true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass',           'off',          true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

async function asSystem<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function privilegeRole(): Promise<string> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') AS exists
  `;
  return rows[0]?.exists ? "oxagen_app" : APP_ROLE;
}

/** Current generation for a scope, or null when no row exists yet. */
async function generationOf(
  orgId: string,
  workspaceId: string | null,
): Promise<number | null> {
  const rows = await asSystem(
    (tx) => tx<{ generation: string }[]>`
      SELECT generation::text AS generation
      FROM iam.authorization_deny_generations
      WHERE org_id = ${orgId}
        AND workspace_id IS NOT DISTINCT FROM ${workspaceId}
    `,
  );
  return rows[0] ? Number(rows[0].generation) : null;
}

// ---------------------------------------------------------------------------
// A1 — tenant isolation
// ---------------------------------------------------------------------------

describe("A1: tenant isolation on the authorization foundation", () => {
  it("an unfiltered read of snapshots returns only the active org's rows", async () => {
    const rows = await asTenant(
      ORG_A,
      WS_A,
      (tx) =>
        tx<
          { org_id: string }[]
        >`SELECT org_id FROM iam.authorization_snapshots`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
  });

  it("org B sees none of org A's snapshots or decisions", async () => {
    const counts = await asTenant(ORG_B, WS_B, async (tx) => {
      const snaps = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM iam.authorization_snapshots`;
      const decisions = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM iam.authorization_decisions`;
      return [snaps[0]?.n, decisions[0]?.n];
    });
    expect(counts).toEqual(["0", "0"]);
  });

  it("blocks writing a snapshot into another tenant", async () => {
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) => tx`
          INSERT INTO iam.authorization_snapshots
            (public_id, org_id, workspace_id, initiating_principal_id, agent_principal_id,
             grant_ceiling, grant_ceiling_digest, snapshot_digest,
             org_deny_generation, workspace_deny_generation)
          VALUES
            ('ras_azf_cross', ${ORG_B}, ${WS_B}, ${HUMAN_PRINCIPAL}, ${AGENT_PRINCIPAL},
             '{}'::jsonb, ${DIGEST_A}, ${DIGEST_C}, 1, 1)
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

// ---------------------------------------------------------------------------
// A2 — ACTUAL database privileges
// ---------------------------------------------------------------------------

describe("A2: authorization privileges, read back from the catalog", () => {
  it("snapshots and decisions are SELECT + INSERT only", async () => {
    const role = await privilegeRole();
    for (const table of IMMUTABLE_TABLES) {
      const rows = await sql<
        { sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
      >`
        SELECT
          has_table_privilege(${role}, ${`iam.${table}`}, 'SELECT') AS sel,
          has_table_privilege(${role}, ${`iam.${table}`}, 'INSERT') AS ins,
          has_table_privilege(${role}, ${`iam.${table}`}, 'UPDATE') AS upd,
          has_table_privilege(${role}, ${`iam.${table}`}, 'DELETE') AS del
      `;
      const p = rows[0]!;
      expect(p.sel, `iam.${table} SELECT`).toBe(true);
      expect(p.ins, `iam.${table} INSERT`).toBe(true);
      expect(p.upd, `iam.${table} must NOT be updatable`).toBe(false);
      expect(p.del, `iam.${table} must NOT be deletable`).toBe(false);
    }
  });

  it("the application role has SELECT ONLY on deny generations", async () => {
    // This is the load-bearing one: INSERT/UPDATE/DELETE here would let the
    // application decrement or reset the counter and silently revive every
    // cached allow that a suspension had just invalidated.
    const role = await privilegeRole();
    const rows = await sql<
      { sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
    >`
      SELECT
        has_table_privilege(${role}, 'iam.authorization_deny_generations', 'SELECT') AS sel,
        has_table_privilege(${role}, 'iam.authorization_deny_generations', 'INSERT') AS ins,
        has_table_privilege(${role}, 'iam.authorization_deny_generations', 'UPDATE') AS upd,
        has_table_privilege(${role}, 'iam.authorization_deny_generations', 'DELETE') AS del
    `;
    const p = rows[0]!;
    expect(p.sel).toBe(true);
    expect(p.ins).toBe(false);
    expect(p.upd).toBe(false);
    expect(p.del).toBe(false);
  });

  it("an emergency deny may be deactivated but never deleted", async () => {
    const role = await privilegeRole();
    const rows = await sql<{ upd: boolean; del: boolean }[]>`
      SELECT
        has_table_privilege(${role}, 'iam.emergency_denies', 'UPDATE') AS upd,
        has_table_privilege(${role}, 'iam.emergency_denies', 'DELETE') AS del
    `;
    expect(rows[0]?.upd).toBe(true);
    expect(rows[0]?.del).toBe(false);
  });

  it("a direct UPDATE of a decision is refused at execution time", async () => {
    await asSystem(
      (tx) => tx`
        INSERT INTO iam.authorization_decisions
          (public_id, org_id, workspace_id, capability_id, request_id,
           actor_principal_id, scope_kind, org_deny_generation, workspace_deny_generation,
           outcome, input_digest, decision_digest)
        VALUES
          ('azd_azf_test_1', ${ORG_A}, ${WS_A}, 'edit_repo_file', 'req-1',
           ${AGENT_PRINCIPAL}, 'workspace', 1, 1, 'allow', ${DIGEST_A}, ${DIGEST_B})
        ON CONFLICT DO NOTHING
      `,
    );
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) =>
          tx`UPDATE iam.authorization_decisions SET outcome = 'allow' WHERE public_id = 'azd_azf_test_1'`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("all four tables have FORCE ROW LEVEL SECURITY and tenant_isolation", async () => {
    for (const table of [
      ...IMMUTABLE_TABLES,
      "emergency_denies",
      "authorization_deny_generations",
    ]) {
      const rows = await sql<{ relrowsecurity: boolean; relforce: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity AS relforce
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'iam' AND c.relname = ${table}
      `;
      expect(rows[0]?.relrowsecurity, `iam.${table} RLS`).toBe(true);
      expect(rows[0]?.relforce, `iam.${table} FORCE RLS`).toBe(true);

      const policies = await sql<{ polname: string }[]>`
        SELECT p.polname FROM pg_policy p
        JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'iam' AND c.relname = ${table}
      `;
      expect(policies.map((p) => p.polname)).toContain("tenant_isolation");
    }
  });
});

// ---------------------------------------------------------------------------
// A3 — the security-definer functions
// ---------------------------------------------------------------------------

describe("A3: deny-generation functions are security definer, pinned, and not public", () => {
  it("all three functions are SECURITY DEFINER with a fixed search_path", async () => {
    const rows = await sql<
      { proname: string; prosecdef: boolean; proconfig: string[] | null }[]
    >`
      SELECT p.proname, p.prosecdef, p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'iam'
        AND p.proname IN ('bump_deny_generation', 'deny_generation_scoped_trigger', 'deny_generation_org_trigger')
      ORDER BY p.proname
    `;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.prosecdef, `${r.proname} must be SECURITY DEFINER`).toBe(true);
      expect(
        (r.proconfig ?? []).some((c) => c.startsWith("search_path=")),
        `${r.proname} must pin search_path`,
      ).toBe(true);
    }
  });

  it("bump_deny_generation carries a function-scoped rls_bypass so a non-superuser owner still bumps", async () => {
    // The counter table has FORCE ROW LEVEL SECURITY, so a NON-superuser
    // definer would be subject to tenant_isolation. A failed bump aborts the
    // SOURCE transaction, meaning a principal suspension would simply not
    // apply — that must not depend on whether the deploy role is a superuser.
    // The SET is function-scoped (saved/restored around the call), so it cannot
    // leak into the caller's transaction.
    const rows = await sql<{ proconfig: string[] | null }[]>`
      SELECT p.proconfig
      FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'iam' AND p.proname = 'bump_deny_generation'
    `;
    expect(rows[0]?.proconfig ?? []).toContain("app.rls_bypass=on");
  });

  it("the bypass does NOT leak into the caller's transaction", async () => {
    // If the migration ever used set_config(..., true) in the body instead of
    // the CREATE FUNCTION SET clause, the bypass would be transaction-scoped
    // and every statement after an IAM write would silently run unfiltered.
    const after = await asSystem(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'off', true)`;
      await tx`SELECT set_config('app.current_org_id', ${ORG_A}, true)`;
      await tx`SELECT set_config('app.current_workspace_id', ${WS_A}, true)`;
      await tx`UPDATE iam.principals SET display_name = 'AZF Human' WHERE id = ${HUMAN_PRINCIPAL}`;
      return tx<
        { v: string | null }[]
      >`SELECT current_setting('app.rls_bypass', true) AS v`;
    });
    expect(after[0]?.v).toBe("off");
  });

  it("PUBLIC cannot execute the bump function", async () => {
    // Otherwise any role could invalidate an arbitrary tenant's cached allows —
    // a denial-of-service on authorization.
    const rows = await sql<{ can: boolean }[]>`
      SELECT has_function_privilege(
        'public', 'iam.bump_deny_generation(uuid, uuid)', 'EXECUTE'
      ) AS can
    `;
    expect(rows[0]?.can).toBe(false);
  });

  it("the application role cannot execute it either", async () => {
    const role = await privilegeRole();
    const rows = await sql<{ can: boolean }[]>`
      SELECT has_function_privilege(
        ${role}, 'iam.bump_deny_generation(uuid, uuid)', 'EXECUTE'
      ) AS can
    `;
    expect(rows[0]?.can).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A4 — generation bumps happen in the same transaction as the narrowing
// ---------------------------------------------------------------------------

describe("A4: every authority-narrowing mutation advances the generation", () => {
  it("suspending a principal bumps both the org and workspace generations", async () => {
    const orgBefore = await generationOf(ORG_A, null);
    const wsBefore = await generationOf(ORG_A, WS_A);

    await asSystem(
      (tx) =>
        tx`UPDATE iam.principals SET status = 'suspended' WHERE id = ${AGENT_PRINCIPAL}`,
    );

    const orgAfter = await generationOf(ORG_A, null);
    const wsAfter = await generationOf(ORG_A, WS_A);
    expect(orgAfter).not.toBeNull();
    expect(wsAfter).not.toBeNull();
    expect(orgAfter!).toBeGreaterThan(orgBefore ?? 0);
    expect(wsAfter!).toBeGreaterThan(wsBefore ?? 0);
  });

  it("the bump is visible INSIDE the same transaction as the change", async () => {
    // If the bump were asynchronous, an authorization check racing the
    // suspension could still read the pre-suspension generation and allow one
    // more operation. Reading the new value inside the transaction proves it
    // is not.
    const observed = await asSystem(async (tx) => {
      const before = await tx<{ g: string }[]>`
        SELECT generation::text AS g FROM iam.authorization_deny_generations
        WHERE org_id = ${ORG_A} AND workspace_id IS NULL
      `;
      await tx`UPDATE iam.principals SET status = 'active' WHERE id = ${AGENT_PRINCIPAL}`;
      const after = await tx<{ g: string }[]>`
        SELECT generation::text AS g FROM iam.authorization_deny_generations
        WHERE org_id = ${ORG_A} AND workspace_id IS NULL
      `;
      return { before: Number(before[0]!.g), after: Number(after[0]!.g) };
    });
    expect(observed.after).toBeGreaterThan(observed.before);
  });

  it("a role-grant change bumps the org generation", async () => {
    const before = await generationOf(ORG_A, null);
    await asSystem(
      (tx) => tx`
        INSERT INTO iam.role_grants (public_id, org_id, role_id, capability_id, effect)
        VALUES ('azf_test_rlg', ${ORG_A}, ${ROLE_ID}, 'edit_repo_file', 'allow')
        ON CONFLICT DO NOTHING
      `,
    );
    const after = await generationOf(ORG_A, null);
    expect(after!).toBeGreaterThan(before!);
  });

  it("a principal-role assignment change bumps the generation", async () => {
    const before = await generationOf(ORG_A, WS_A);
    await asSystem(
      (tx) => tx`
        INSERT INTO iam.principal_role_assignments
          (public_id, principal_id, role_id, org_id, workspace_id)
        VALUES ('azf_test_pra', ${AGENT_PRINCIPAL}, ${ROLE_ID}, ${ORG_A}, ${WS_A})
        ON CONFLICT DO NOTHING
      `,
    );
    const after = await generationOf(ORG_A, WS_A);
    expect(after!).toBeGreaterThan(before!);
  });

  it("activating an emergency deny bumps the generation", async () => {
    const before = await generationOf(ORG_A, WS_A);
    await asSystem(
      (tx) => tx`
        INSERT INTO iam.emergency_denies
          (public_id, org_id, workspace_id, scope_kind, deny_kind, capability_id, reason)
        VALUES ('emd_azf_test_1', ${ORG_A}, ${WS_A}, 'workspace', 'capability', 'edit_repo_file', 'incident 42')
        ON CONFLICT DO NOTHING
      `,
    );
    const after = await generationOf(ORG_A, WS_A);
    expect(after!).toBeGreaterThan(before!);
  });

  it("deleting a principal bumps the generation from the OLD row's scope", async () => {
    const before = await generationOf(ORG_B, null);
    await asSystem(async (tx) => {
      await tx`
        INSERT INTO iam.principals (public_id, org_id, workspace_id, kind, display_name, status)
        VALUES ('azf_test_prn_del', ${ORG_B}, ${WS_B}, 'service', 'AZF Temp', 'active')
      `;
      await tx`DELETE FROM iam.principals WHERE public_id = 'azf_test_prn_del'`;
    });
    const after = await generationOf(ORG_B, null);
    // Insert bumped once, delete bumped again — the counter never rewinds.
    expect(after!).toBeGreaterThan(before ?? 0);
  });

  it("the generation never decreases across a full narrow/restore cycle", async () => {
    const start = await generationOf(ORG_A, WS_A);
    await asSystem(
      (tx) => tx`
        UPDATE iam.emergency_denies
        SET active = false, deactivated_at = now()
        WHERE public_id = 'emd_azf_test_1'
      `,
    );
    const end = await generationOf(ORG_A, WS_A);
    expect(end!).toBeGreaterThan(start!);
  });
});

// ---------------------------------------------------------------------------
// A5 — typed constraints
// ---------------------------------------------------------------------------

describe("A5: typed deny and decision constraints", () => {
  it("rejects an emergency deny targeting BOTH a capability and a resource scope", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.emergency_denies
            (public_id, org_id, workspace_id, scope_kind, deny_kind,
             capability_id, resource_scope_digest, reason)
          VALUES ('emd_azf_bad', ${ORG_A}, ${WS_A}, 'workspace', 'capability',
                  'edit_repo_file', ${DIGEST_A}, 'ambiguous')
        `,
      ),
    ).rejects.toThrow(/emergency_denies_deny_kind_check/);
  });

  it("rejects an org-scoped deny that names a workspace", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.emergency_denies
            (public_id, org_id, workspace_id, scope_kind, deny_kind, capability_id, reason)
          VALUES ('emd_azf_bad2', ${ORG_A}, ${WS_A}, 'org', 'capability', 'x', 'mismatched scope')
        `,
      ),
    ).rejects.toThrow(/emergency_denies_scope_kind_check/);
  });

  it("rejects an active deny that already carries a deactivation time", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.emergency_denies
            (public_id, org_id, workspace_id, scope_kind, deny_kind, capability_id, reason,
             active, deactivated_at)
          VALUES ('emd_azf_bad3', ${ORG_A}, ${WS_A}, 'workspace', 'capability', 'x', 'r',
                  true, now())
        `,
      ),
    ).rejects.toThrow(/emergency_denies_active_check/);
  });

  it("rejects a snapshot whose two principals are the same", async () => {
    // A self-delegation means the ceiling is not actually an intersection.
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.authorization_snapshots
            (public_id, org_id, workspace_id, initiating_principal_id, agent_principal_id,
             grant_ceiling, grant_ceiling_digest, snapshot_digest,
             org_deny_generation, workspace_deny_generation)
          VALUES ('ras_azf_self', ${ORG_A}, ${WS_A}, ${AGENT_PRINCIPAL}, ${AGENT_PRINCIPAL},
                  '{}'::jsonb, ${DIGEST_A}, ${DIGEST_C}, 1, 1)
        `,
      ),
    ).rejects.toThrow(/authorization_snapshots_principals_distinct_check/);
  });

  it("rejects a decision with a partial run binding", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.authorization_decisions
            (public_id, org_id, workspace_id, capability_id, request_id,
             actor_principal_id, scope_kind, run_id,
             org_deny_generation, workspace_deny_generation,
             outcome, input_digest, decision_digest)
          VALUES ('azd_azf_partial', ${ORG_A}, ${WS_A}, 'edit_repo_file', 'req-2',
                  ${AGENT_PRINCIPAL}, 'workspace', gen_random_uuid(),
                  1, 1, 'deny', ${DIGEST_A}, ${DIGEST_C})
        `,
      ),
    ).rejects.toThrow(/authorization_decisions_run_binding_check/);
  });

  it("rejects an approval_pending decision with no approval request", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.authorization_decisions
            (public_id, org_id, workspace_id, capability_id, request_id,
             actor_principal_id, scope_kind,
             org_deny_generation, workspace_deny_generation,
             outcome, input_digest, decision_digest)
          VALUES ('azd_azf_pending', ${ORG_A}, ${WS_A}, 'edit_repo_file', 'req-3',
                  ${AGENT_PRINCIPAL}, 'workspace', 1, 1,
                  'approval_pending', ${DIGEST_A}, ${DIGEST_C})
        `,
      ),
    ).rejects.toThrow(/authorization_decisions_approval_check/);
  });

  it("rejects a workspace-scoped decision that omits the workspace generation", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO iam.authorization_decisions
            (public_id, org_id, workspace_id, capability_id, request_id,
             actor_principal_id, scope_kind, org_deny_generation,
             outcome, input_digest, decision_digest)
          VALUES ('azd_azf_nogen', ${ORG_A}, ${WS_A}, 'edit_repo_file', 'req-4',
                  ${AGENT_PRINCIPAL}, 'workspace', 1,
                  'deny', ${DIGEST_A}, ${DIGEST_C})
        `,
      ),
    ).rejects.toThrow(/authorization_decisions_generation_check/);
  });

  it("accepts an error outcome — an evaluation failure is still a recorded decision", async () => {
    const rows = await asSystem(
      (tx) => tx<{ outcome: string }[]>`
        INSERT INTO iam.authorization_decisions
          (public_id, org_id, workspace_id, capability_id, request_id,
           actor_principal_id, scope_kind, org_deny_generation, workspace_deny_generation,
           outcome, reason_code, input_digest, decision_digest)
        VALUES ('azd_azf_error', ${ORG_A}, ${WS_A}, 'edit_repo_file', 'req-5',
                ${AGENT_PRINCIPAL}, 'workspace', 1, 1,
                'error', 'iam_unavailable', ${DIGEST_A}, ${DIGEST_C})
        RETURNING outcome
      `,
    );
    expect(rows[0]?.outcome).toBe("error");
  });
});
