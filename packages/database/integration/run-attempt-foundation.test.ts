/**
 * Fenced run/attempt foundation — live-database proof
 * (docs/specs/run-evidence-ingress/spec.md,
 *  02-run-attempt-foundation-plan.md Task 2).
 *
 * The unit tests in src/__tests__/schema-append-only.test.ts assert the Drizzle
 * SHAPE. This file asserts the things only a real Postgres can answer:
 *
 *   T1  tenant isolation on every new foundation table
 *   T2  scope agreement — an attempt cannot be written into another tenant
 *   T3  ACTUAL database privileges: append-only tables have no UPDATE/DELETE
 *   T4  fence enforcement — one lease per attempt, one epoch per run
 *   T5  the V1/V2 partial constraints, including the dropped full unique
 *   T6  same-transaction seal → grant → obligation, and its atomic rollback
 *   T7  the V2 immutability trigger on agent_runs
 *
 * NOTE ON SUPERUSER AND RLS/PRIVILEGES: PostgreSQL superusers bypass RLS
 * unconditionally even under FORCE ROW LEVEL SECURITY, and privilege checks
 * against a superuser always return true. Like integration/rls.test.ts, this
 * suite creates a non-superuser role and uses SET LOCAL ROLE inside the
 * isolation transactions. The privilege assertions (T3) query
 * has_table_privilege() for the real `oxagen_app` role when it exists, and fall
 * back to the test role otherwise, so the append-only posture is read back from
 * the catalog rather than assumed from the migration text.
 *
 * CI: rls-integration job (TENANT_RLS_ENFORCEMENT_ENABLED=true, clean DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database test:integration -- integration/run-attempt-foundation.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

// ---------------------------------------------------------------------------
// Deterministic UUIDs — same values in beforeAll/afterAll for safe cleanup.
// ---------------------------------------------------------------------------

const ORG_A = "00000000-0000-0000-0011-000000000001";
const ORG_B = "00000000-0000-0000-0011-000000000002";
const WS_A = "00000000-0000-0000-0012-000000000001";
const WS_B = "00000000-0000-0000-0012-000000000002";

const RUN_V1 = "00000000-0000-0000-0013-000000000001";
const RUN_V2 = "00000000-0000-0000-0013-000000000002";
const ATTEMPT_1 = "00000000-0000-0000-0014-000000000001";
const ATTEMPT_2 = "00000000-0000-0000-0014-000000000002";
const SNAPSHOT_ID = "00000000-0000-0000-0015-000000000001";
const RETENTION_ID = "00000000-0000-0000-0016-000000000001";
const BINDING_ID = "00000000-0000-0000-0017-000000000001";
const CONNECTION_ID = "00000000-0000-0000-0018-000000000001";

const APP_ROLE = "raf_test_app_role";

/** A syntactically valid algorithm-qualified digest (64 lowercase hex). */
const D = (seed: string): string => `sha256:${seed.repeat(64).slice(0, 64)}`;
const DIGEST_A = D("a");
const DIGEST_B = D("b");
const DIGEST_C = D("c");
const EMPTY_STREAM_DIGEST = D("e");

// The tables whose application-role grants must be SELECT + INSERT only.
const APPEND_ONLY_TABLES: ReadonlyArray<[string, string]> = [
  ["agent", "agent_run_attempts"],
  ["agent", "agent_run_checkpoints"],
  ["agent", "agent_run_attempt_seals"],
  ["agent", "agent_run_finalization_grants"],
  ["agent", "agent_run_finalization_obligations"],
  ["agent", "agent_run_events"],
  ["ingestion", "repository_bindings"],
  ["evidence", "retention_policy_versions"],
];

// Mutable operational state: UPDATE allowed, DELETE still denied.
const UPDATE_BUT_NEVER_DELETE_TABLES: ReadonlyArray<[string, string]> = [
  ["agent", "agent_run_attempt_leases"],
  ["ingestion", "repository_binding_heads"],
  ["ingestion", "governed_repository_selections"],
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

  for (const schema of ["agent", "ingestion", "evidence", "iam"]) {
    await sql.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO "${APP_ROLE}"`);
  }
  // Mirror the migration's posture onto the test role so the isolation
  // assertions run under realistic privileges.
  for (const [schema, table] of APPEND_ONLY_TABLES) {
    await sql.unsafe(
      `GRANT SELECT, INSERT ON ${schema}.${table} TO "${APP_ROLE}"`,
    );
  }
  for (const [schema, table] of UPDATE_BUT_NEVER_DELETE_TABLES) {
    await sql.unsafe(
      `GRANT SELECT, INSERT, UPDATE ON ${schema}.${table} TO "${APP_ROLE}"`,
    );
  }
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE ON agent.agent_runs TO "${APP_ROLE}"`,
  );

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;

    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG_A}, 'raf_test_org_a', 'RAF Org A', 'raf-org-a', 'rafa', 'free', 'active', 'business'),
        (${ORG_B}, 'raf_test_org_b', 'RAF Org B', 'raf-org-b', 'rafb', 'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'raf_test_ws_a', ${ORG_A}, 'RAF WS A', 'raf-ws-a', 'rwsa'),
        (${WS_B}, 'raf_test_ws_b', ${ORG_B}, 'RAF WS B', 'raf-ws-b', 'rwsb')
      ON CONFLICT (id) DO NOTHING
    `;

    // The pinned retention-policy version and repository binding a V2 run
    // must reference. Both are immutable and versioned.
    await tx`
      INSERT INTO evidence.retention_policy_versions
        (id, public_id, org_id, workspace_id, version, mode, ttl_days, policy_digest)
      VALUES
        (${RETENTION_ID}, 'raf_test_rpv', ${ORG_A}, ${WS_A}, 1, 'content_exact', 90, ${DIGEST_A})
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO ingestion.repository_bindings
        (id, public_id, org_id, workspace_id, connection_id, provider,
         provider_repository_id, provider_owner, provider_name, provider_full_name,
         configured_default_ref, observed_at, version)
      VALUES
        (${BINDING_ID}, 'raf_test_rpb', ${ORG_A}, ${WS_A}, ${CONNECTION_ID}, 'github',
         '918273645', 'oxageninc', 'oxagen-platform', 'oxageninc/oxagen-platform',
         'main', now(), 1)
      ON CONFLICT (id) DO NOTHING
    `;

    // A PRESERVED V1 run — the drain-window row every constraint must keep
    // valid without inventing trusted identity for it.
    await tx`
      INSERT INTO agent.agent_runs
        (id, public_id, org_id, workspace_id, surface, status, spec)
      VALUES
        (${RUN_V1}, 'raf_test_run_v1', ${ORG_A}, ${WS_A}, 'chat', 'pending', '{"version":1}'::jsonb)
      ON CONFLICT (id) DO NOTHING
    `;

    // A governed V2 run with the COMPLETE typed identity set.
    await tx`
      INSERT INTO agent.agent_runs
        (id, public_id, org_id, workspace_id, surface, status, spec,
         spec_version, run_kind, spec_digest,
         initiating_principal_id, agent_principal_id, agent_id, agent_version_id,
         agent_version_checksum, authorization_snapshot_id,
         repository_binding_id, repository_provider, provider_repository_id,
         repository_connection_id, configured_default_ref, base_commit_sha, base_tree_sha,
         retention_policy_id, retention_policy_digest, max_attempts)
      VALUES
        (${RUN_V2}, 'raf_test_run_v2', ${ORG_A}, ${WS_A}, 'repo-edit', 'pending', '{"version":2}'::jsonb,
         2, 'repo_edit', ${DIGEST_B},
         gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
         ${DIGEST_C}, ${SNAPSHOT_ID},
         ${BINDING_ID}, 'github', '918273645',
         ${CONNECTION_ID}, 'main', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
         ${RETENTION_ID}, ${DIGEST_A}, 3)
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO agent.agent_run_attempts
        (id, public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
         engine_name, engine_version, engine_build_digest)
      VALUES
        (${ATTEMPT_1}, 'raf_test_arat_1', ${ORG_A}, ${WS_A}, ${RUN_V2}, 1, 'worker-1',
         'ts-engine', '2.0.0', ${DIGEST_A})
      ON CONFLICT (id) DO NOTHING
    `;

    await tx`
      INSERT INTO agent.agent_run_attempt_leases
        (org_id, workspace_id, attempt_id, run_id, lease_token, lease_epoch,
         worker_id, expires_at)
      VALUES
        (${ORG_A}, ${WS_A}, ${ATTEMPT_1}, ${RUN_V2}, 'tok-1', 1, 'worker-1', now() + interval '5 minutes')
      ON CONFLICT DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM agent.agent_run_finalization_obligations WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_finalization_grants WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_attempt_seals WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_checkpoints WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_attempt_leases WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_events WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_run_attempts WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM agent.agent_runs WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM ingestion.governed_repository_selections WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM ingestion.repository_binding_heads WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM ingestion.repository_bindings WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM evidence.retention_policy_versions WHERE org_id IN (${ORG_A}, ${ORG_B})`;
    await tx`DELETE FROM workspace.workspaces WHERE id IN (${WS_A}, ${WS_B})`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
  });

  for (const [schema, table] of [
    ...APPEND_ONLY_TABLES,
    ...UPDATE_BUT_NEVER_DELETE_TABLES,
    ["agent", "agent_runs"] as [string, string],
  ]) {
    await sql
      .unsafe(`REVOKE ALL ON ${schema}.${table} FROM "${APP_ROLE}"`)
      .catch(() => undefined);
  }
  for (const schema of ["agent", "ingestion", "evidence", "iam"]) {
    await sql
      .unsafe(`REVOKE USAGE ON SCHEMA ${schema} FROM "${APP_ROLE}"`)
      .catch(() => undefined);
  }
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);

  await sql.end({ timeout: 5 });
});

/**
 * Run a callback as the non-superuser role with tenant GUCs set and bypass off,
 * so RLS policies are actually evaluated. SET LOCAL ROLE is reset implicitly at
 * transaction end.
 */
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

/** Run as superuser with bypass on — for seeding and constraint probes. */
async function asSystem<T>(
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

/**
 * The role whose privileges we assert. Prefer the real `oxagen_app` when the
 * cluster has it (CI and local docker both do); fall back to the test role so
 * the suite still proves the shape on a bare cluster.
 */
async function privilegeRole(): Promise<string> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') AS exists
  `;
  return rows[0]?.exists ? "oxagen_app" : APP_ROLE;
}

// ---------------------------------------------------------------------------
// T1 — tenant isolation
// ---------------------------------------------------------------------------

describe("T1: tenant isolation on the attempt foundation", () => {
  it("an unfiltered read of attempts returns only the active org's rows", async () => {
    const rows = await asTenant(
      ORG_A,
      WS_A,
      (tx) =>
        tx<{ org_id: string }[]>`SELECT org_id FROM agent.agent_run_attempts`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.org_id === ORG_A)).toBe(true);
  });

  it("org B sees none of org A's attempts, leases, or bindings", async () => {
    const counts = await asTenant(ORG_B, WS_B, async (tx) => {
      const attempts = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM agent.agent_run_attempts`;
      const leases = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM agent.agent_run_attempt_leases`;
      const bindings = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM ingestion.repository_bindings`;
      const retention = await tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM evidence.retention_policy_versions`;
      return [attempts[0]?.n, leases[0]?.n, bindings[0]?.n, retention[0]?.n];
    });
    expect(counts).toEqual(["0", "0", "0", "0"]);
  });

  it("no GUC + bypass off returns zero rows (fail-closed)", async () => {
    const rows = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
      await tx`SELECT set_config('app.rls_bypass', 'off', true)`;
      return tx<
        { n: string }[]
      >`SELECT count(*)::text AS n FROM agent.agent_run_attempts`;
    });
    expect(rows[0]?.n).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// T2 — scope agreement across tenants
// ---------------------------------------------------------------------------

describe("T2: an attempt cannot be written into another tenant", () => {
  it("WITH CHECK blocks inserting an org-B-scoped attempt while scoped to org A", async () => {
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) => tx`
          INSERT INTO agent.agent_run_attempts
            (public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
             engine_name, engine_version, engine_build_digest)
          VALUES
            ('raf_test_cross', ${ORG_B}, ${WS_B}, ${RUN_V2}, 99, 'w', 'e', '1', ${DIGEST_A})
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("WITH CHECK blocks a cross-tenant finalization grant", async () => {
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) => tx`
          INSERT INTO agent.agent_run_finalization_grants
            (public_id, org_id, workspace_id, run_id, attempt_id, seal_id,
             attempt_public_id, event_count, final_event_digest, event_stream_digest)
          VALUES
            ('raf_test_afg_cross', ${ORG_B}, ${WS_B}, ${RUN_V2}, ${ATTEMPT_1}, gen_random_uuid(),
             'raf_test_arat_1', 1, ${DIGEST_A}, ${DIGEST_B})
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

// ---------------------------------------------------------------------------
// T3 — ACTUAL database privileges
// ---------------------------------------------------------------------------

describe("T3: append-only privileges, read back from the catalog", () => {
  it("the application role has SELECT + INSERT and NOT UPDATE/DELETE on every evidence-bearing table", async () => {
    const role = await privilegeRole();
    for (const [schema, table] of APPEND_ONLY_TABLES) {
      const rows = await sql<
        { sel: boolean; ins: boolean; upd: boolean; del: boolean }[]
      >`
        SELECT
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'SELECT') AS sel,
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'INSERT') AS ins,
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'UPDATE') AS upd,
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'DELETE') AS del
      `;
      const p = rows[0]!;
      expect(p.sel, `${schema}.${table} SELECT`).toBe(true);
      expect(p.ins, `${schema}.${table} INSERT`).toBe(true);
      expect(p.upd, `${schema}.${table} must NOT be updatable`).toBe(false);
      expect(p.del, `${schema}.${table} must NOT be deletable`).toBe(false);
    }
  });

  it("operational state may be UPDATEd but never DELETEd", async () => {
    const role = await privilegeRole();
    for (const [schema, table] of UPDATE_BUT_NEVER_DELETE_TABLES) {
      const rows = await sql<{ upd: boolean; del: boolean }[]>`
        SELECT
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'UPDATE') AS upd,
          has_table_privilege(${role}, ${`${schema}.${table}`}, 'DELETE') AS del
      `;
      expect(rows[0]?.upd, `${schema}.${table} UPDATE`).toBe(true);
      expect(rows[0]?.del, `${schema}.${table} must NOT be deletable`).toBe(
        false,
      );
    }
  });

  it("an UPDATE against a sealed attempt is refused at execution time", async () => {
    // The privilege check above proves the grant; this proves the engine
    // actually enforces it for a live statement.
    await expect(
      asTenant(
        ORG_A,
        WS_A,
        (tx) =>
          tx`UPDATE agent.agent_run_attempts SET worker_id = 'hijack' WHERE id = ${ATTEMPT_1}`,
      ),
    ).rejects.toThrow(/permission denied/i);
  });

  it("every foundation table has FORCE ROW LEVEL SECURITY and a tenant_isolation policy", async () => {
    const tables = [...APPEND_ONLY_TABLES, ...UPDATE_BUT_NEVER_DELETE_TABLES];
    for (const [schema, table] of tables) {
      const rows = await sql<{ relrowsecurity: boolean; relforce: boolean }[]>`
        SELECT c.relrowsecurity, c.relforcerowsecurity AS relforce
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relname = ${table}
      `;
      expect(rows[0]?.relrowsecurity, `${schema}.${table} RLS enabled`).toBe(
        true,
      );
      expect(rows[0]?.relforce, `${schema}.${table} FORCE RLS`).toBe(true);

      const policies = await sql<{ polname: string }[]>`
        SELECT p.polname
        FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${schema} AND c.relname = ${table}
      `;
      expect(
        policies.map((p) => p.polname),
        `${schema}.${table} tenant_isolation`,
      ).toContain("tenant_isolation");
    }
  });
});

// ---------------------------------------------------------------------------
// T4 — fence enforcement
// ---------------------------------------------------------------------------

describe("T4: lease fencing", () => {
  it("rejects a second lease for the same attempt", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_attempt_leases
            (org_id, workspace_id, attempt_id, run_id, lease_token, lease_epoch, worker_id, expires_at)
          VALUES
            (${ORG_A}, ${WS_A}, ${ATTEMPT_1}, ${RUN_V2}, 'tok-dup', 2, 'worker-2', now() + interval '5 minutes')
        `,
      ),
    ).rejects.toThrow(/agent_run_attempt_leases_attempt_uq/);
  });

  it("rejects reusing a fencing epoch within one run", async () => {
    // A successor attempt exists, but epoch 1 was already consumed — reusing it
    // would let a stale worker's late write be accepted as current.
    await asSystem(
      (tx) => tx`
        INSERT INTO agent.agent_run_attempts
          (id, public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
           engine_name, engine_version, engine_build_digest)
        VALUES
          (${ATTEMPT_2}, 'raf_test_arat_2', ${ORG_A}, ${WS_A}, ${RUN_V2}, 2, 'worker-2',
           'ts-engine', '2.0.0', ${DIGEST_A})
        ON CONFLICT (id) DO NOTHING
      `,
    );
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_attempt_leases
            (org_id, workspace_id, attempt_id, run_id, lease_token, lease_epoch, worker_id, expires_at)
          VALUES
            (${ORG_A}, ${WS_A}, ${ATTEMPT_2}, ${RUN_V2}, 'tok-2', 1, 'worker-2', now() + interval '5 minutes')
        `,
      ),
    ).rejects.toThrow(/agent_run_attempt_leases_run_epoch_uq/);
  });

  it("rejects a fenced_at without a reason (half-fenced lease)", async () => {
    await expect(
      asSystem(
        (tx) =>
          tx`UPDATE agent.agent_run_attempt_leases SET fenced_at = now() WHERE attempt_id = ${ATTEMPT_1}`,
      ),
    ).rejects.toThrow(/agent_run_attempt_leases_fence_check/);
  });

  it("rejects a duplicate attempt number within one run", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_attempts
            (public_id, org_id, workspace_id, run_id, attempt_number, worker_id,
             engine_name, engine_version, engine_build_digest)
          VALUES
            ('raf_test_arat_dup', ${ORG_A}, ${WS_A}, ${RUN_V2}, 1, 'worker-3', 'e', '1', ${DIGEST_A})
        `,
      ),
    ).rejects.toThrow(/agent_run_attempts_run_attempt_uq/);
  });
});

// ---------------------------------------------------------------------------
// T5 — the V1/V2 partial constraints
// ---------------------------------------------------------------------------

describe("T5: V1/V2 event discriminant", () => {
  it("accepts a legacy V1 event and a V2 event on the same run", async () => {
    const inserted = await asSystem(async (tx) => {
      await tx`
        INSERT INTO agent.agent_run_events
          (org_id, workspace_id, run_id, seq, type, payload)
        VALUES (${ORG_A}, ${WS_A}, ${RUN_V1}, 1, 'legacy.tick', '{}'::jsonb)
      `;
      await tx`
        INSERT INTO agent.agent_run_events
          (org_id, workspace_id, run_id, event_record_version, attempt_id,
           run_seq, attempt_seq, event_schema_version, event_type, stage,
           payload_digest, event_digest, payload_inline, observed_at)
        VALUES (${ORG_A}, ${WS_A}, ${RUN_V2}, 2, ${ATTEMPT_1},
                1, 1, 'agent-event/v1', 'admission.accepted', 'admission',
                ${DIGEST_A}, ${DIGEST_B}, '{"ok":true}'::jsonb, now())
      `;
      return tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM agent.agent_run_events WHERE org_id = ${ORG_A}
      `;
    });
    expect(inserted[0]?.n).toBe("2");
  });

  it("the full UNIQUE(run_id, seq) constraint is GONE (replaced by partials)", async () => {
    const rows = await sql<{ conname: string }[]>`
      SELECT con.conname
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'agent' AND c.relname = 'agent_run_events'
        AND con.contype = 'u'
    `;
    expect(rows.map((r) => r.conname)).not.toContain(
      "agent_run_events_run_seq_uq",
    );
  });

  it("all three partial unique indexes exist WITH predicates", async () => {
    const rows = await sql<{ indexname: string; indexdef: string }[]>`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE schemaname = 'agent' AND tablename = 'agent_run_events'
    `;
    const byName = new Map(rows.map((r) => [r.indexname, r.indexdef]));
    for (const name of [
      "agent_run_events_v1_run_seq_uq",
      "agent_run_events_v2_run_seq_uq",
      "agent_run_events_v2_attempt_seq_uq",
    ]) {
      expect(byName.has(name), `missing ${name}`).toBe(true);
      expect(byName.get(name), `${name} must be partial`).toContain("WHERE");
      expect(byName.get(name)).toContain("event_record_version");
    }
  });

  it("rejects a V2 event that also carries legacy seq/type/payload", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_events
            (org_id, workspace_id, run_id, event_record_version, attempt_id,
             run_seq, attempt_seq, event_schema_version, event_type, stage,
             payload_digest, event_digest, payload_inline, observed_at,
             seq, type, payload)
          VALUES (${ORG_A}, ${WS_A}, ${RUN_V2}, 2, ${ATTEMPT_1},
                  2, 2, 'agent-event/v1', 'model.call', 'model',
                  ${DIGEST_A}, ${DIGEST_C}, '{}'::jsonb, now(),
                  2, 'legacy', '{}'::jsonb)
        `,
      ),
    ).rejects.toThrow(/agent_run_events_record_shape_check/);
  });

  it("rejects a V2 event carrying BOTH an inline payload and an encrypted ref", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_events
            (org_id, workspace_id, run_id, event_record_version, attempt_id,
             run_seq, attempt_seq, event_schema_version, event_type, stage,
             payload_digest, event_digest, payload_inline, encrypted_payload_ref, observed_at)
          VALUES (${ORG_A}, ${WS_A}, ${RUN_V2}, 2, ${ATTEMPT_1},
                  3, 3, 'agent-event/v1', 'model.call', 'model',
                  ${DIGEST_A}, ${DIGEST_C}, '{}'::jsonb, 'evb_abc', now())
        `,
      ),
    ).rejects.toThrow(/agent_run_events_record_shape_check/);
  });

  it("rejects an unknown evidence stage", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_events
            (org_id, workspace_id, run_id, event_record_version, attempt_id,
             run_seq, attempt_seq, event_schema_version, event_type, stage,
             payload_digest, event_digest, payload_inline, observed_at)
          VALUES (${ORG_A}, ${WS_A}, ${RUN_V2}, 2, ${ATTEMPT_1},
                  4, 4, 'agent-event/v1', 'x', 'not_a_stage',
                  ${DIGEST_A}, ${DIGEST_C}, '{}'::jsonb, now())
        `,
      ),
    ).rejects.toThrow(/agent_run_events_stage_check/);
  });

  it("rejects a partially-bound V2 run (missing repository binding)", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_runs
            (public_id, org_id, workspace_id, surface, status, spec,
             spec_version, run_kind, spec_digest,
             initiating_principal_id, agent_principal_id, agent_id, agent_version_id,
             agent_version_checksum, authorization_snapshot_id,
             retention_policy_id, retention_policy_digest, max_attempts)
          VALUES
            ('raf_test_run_partial', ${ORG_A}, ${WS_A}, 'repo-edit', 'pending', '{}'::jsonb,
             2, 'repo_edit', ${DIGEST_B},
             gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
             ${DIGEST_C}, ${SNAPSHOT_ID},
             ${RETENTION_ID}, ${DIGEST_A}, 3)
        `,
      ),
    ).rejects.toThrow(/agent_runs_v2_identity_check/);
  });

  it("rejects a V1 run that smuggles in a trusted principal", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_runs
            (public_id, org_id, workspace_id, surface, status, spec,
             spec_version, initiating_principal_id)
          VALUES
            ('raf_test_run_smuggle', ${ORG_A}, ${WS_A}, 'chat', 'pending', '{}'::jsonb,
             1, gen_random_uuid())
        `,
      ),
    ).rejects.toThrow(/agent_runs_v2_identity_check/);
  });
});

// ---------------------------------------------------------------------------
// T6 — same-transaction seal → grant → obligation
// ---------------------------------------------------------------------------

describe("T6: seal, grant, and obligation are one atomic unit", () => {
  it("creates all three in a single transaction with the grant id as submission id", async () => {
    const result = await asSystem(async (tx) => {
      const sealRows = await tx<{ id: string }[]>`
        INSERT INTO agent.agent_run_attempt_seals
          (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
           final_run_seq, final_attempt_seq, final_event_digest, event_stream_digest,
           sealer_kind, sealer_worker_id)
        VALUES
          (${ORG_A}, ${WS_A}, ${RUN_V2}, ${ATTEMPT_1}, 'completed', 1,
           1, 1, ${DIGEST_B}, ${DIGEST_C}, 'worker', 'worker-1')
        RETURNING id
      `;
      const sealId = sealRows[0]!.id;

      const grantRows = await tx<{ id: string; public_id: string }[]>`
        INSERT INTO agent.agent_run_finalization_grants
          (public_id, org_id, workspace_id, run_id, attempt_id, seal_id,
           attempt_public_id, event_count, final_event_digest, event_stream_digest)
        VALUES
          ('afg_raf_test_1', ${ORG_A}, ${WS_A}, ${RUN_V2}, ${ATTEMPT_1}, ${sealId},
           'raf_test_arat_1', 1, ${DIGEST_B}, ${DIGEST_C})
        RETURNING id, public_id
      `;
      const grant = grantRows[0]!;

      await tx`
        INSERT INTO agent.agent_run_finalization_obligations
          (org_id, workspace_id, grant_id, submission_id, run_id, attempt_id, seal_id)
        VALUES
          (${ORG_A}, ${WS_A}, ${grant.id}, ${grant.public_id}, ${RUN_V2}, ${ATTEMPT_1}, ${sealId})
      `;

      return tx<{ submission_id: string; capability_id: string }[]>`
        SELECT o.submission_id, g.capability_id
        FROM agent.agent_run_finalization_obligations o
        JOIN agent.agent_run_finalization_grants g ON g.id = o.grant_id
        WHERE o.attempt_id = ${ATTEMPT_1}
      `;
    });

    // The grant's public id IS the stable submission id every retry reuses.
    expect(result[0]?.submission_id).toBe("afg_raf_test_1");
    expect(result[0]?.capability_id).toBe("ingest_run_evidence");
  });

  it("rejects a second seal for the same attempt (duplicate sweep is idempotent)", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_attempt_seals
            (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
             event_stream_digest, sealer_kind, sealer_worker_id)
          VALUES
            (${ORG_A}, ${WS_A}, ${RUN_V2}, ${ATTEMPT_1}, 'abandoned', 0,
             ${EMPTY_STREAM_DIGEST}, 'reclaimer', 'sweeper-1')
        `,
      ),
    ).rejects.toThrow(/agent_run_attempt_seals_attempt_uq/);
  });

  it("seals a ZERO-EVENT abandoned attempt without inventing a terminal event", async () => {
    const rows = await asSystem(
      (tx) => tx<{ event_count: number; final_event_digest: string | null }[]>`
        INSERT INTO agent.agent_run_attempt_seals
          (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
           event_stream_digest, sealer_kind, sealer_worker_id)
        VALUES
          (${ORG_A}, ${WS_A}, ${RUN_V2}, ${ATTEMPT_2}, 'abandoned', 0,
           ${EMPTY_STREAM_DIGEST}, 'reclaimer', 'sweeper-1')
        RETURNING event_count, final_event_digest
      `,
    );
    expect(rows[0]?.event_count).toBe(0);
    expect(rows[0]?.final_event_digest).toBeNull();
  });

  it("rejects a zero-event seal that still claims a final-event digest", async () => {
    await expect(
      asSystem(
        (tx) => tx`
          INSERT INTO agent.agent_run_attempt_seals
            (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
             final_run_seq, final_attempt_seq, final_event_digest, event_stream_digest,
             sealer_kind, sealer_worker_id)
          VALUES
            (${ORG_A}, ${WS_A}, ${RUN_V2}, gen_random_uuid(), 'abandoned', 0,
             1, 1, ${DIGEST_B}, ${EMPTY_STREAM_DIGEST}, 'reclaimer', 'sweeper-1')
        `,
      ),
    ).rejects.toThrow(/agent_run_attempt_seals_event_evidence_check/);
  });

  it("rolls the whole unit back when the obligation insert fails", async () => {
    const before = await asSystem(
      (tx) =>
        tx<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM agent.agent_run_attempt_seals WHERE org_id = ${ORG_A}`,
    );

    await expect(
      asSystem(async (tx) => {
        const sealRows = await tx<{ id: string }[]>`
          INSERT INTO agent.agent_run_attempt_seals
            (org_id, workspace_id, run_id, attempt_id, terminal_status, event_count,
             event_stream_digest, sealer_kind, sealer_worker_id)
          VALUES
            (${ORG_A}, ${WS_A}, ${RUN_V2}, gen_random_uuid(), 'failed', 0,
             ${EMPTY_STREAM_DIGEST}, 'worker', 'worker-9')
          RETURNING id
        `;
        // Reusing an already-consumed submission id violates the idempotency
        // key, so the seal above must not survive either.
        await tx`
          INSERT INTO agent.agent_run_finalization_obligations
            (org_id, workspace_id, grant_id, submission_id, run_id, attempt_id, seal_id)
          VALUES
            (${ORG_A}, ${WS_A}, gen_random_uuid(), 'afg_raf_test_1', ${RUN_V2},
             gen_random_uuid(), ${sealRows[0]!.id})
        `;
      }),
    ).rejects.toThrow(/agent_run_finalization_obligations_submission_uq/);

    const after = await asSystem(
      (tx) =>
        tx<
          { n: string }[]
        >`SELECT count(*)::text AS n FROM agent.agent_run_attempt_seals WHERE org_id = ${ORG_A}`,
    );
    expect(after[0]?.n).toBe(before[0]?.n);
  });
});

// ---------------------------------------------------------------------------
// T7 — the V2 immutability trigger
// ---------------------------------------------------------------------------

describe("T7: agent_runs V2 immutability trigger", () => {
  it("allows operational status and pointer updates on a V2 run", async () => {
    const rows = await asSystem(
      (tx) => tx<{ status: string; attempt_count: number }[]>`
        UPDATE agent.agent_runs
        SET status = 'running',
            active_attempt_id = ${ATTEMPT_1},
            attempt_count = 1,
            next_run_seq = 2,
            started_at = now()
        WHERE id = ${RUN_V2}
        RETURNING status, attempt_count
      `,
    );
    expect(rows[0]?.status).toBe("running");
    expect(rows[0]?.attempt_count).toBe(1);
  });

  it("rejects changing a trusted binding on a V2 run", async () => {
    await expect(
      asSystem(
        (tx) =>
          tx`UPDATE agent.agent_runs SET base_commit_sha = 'cccccccccccccccccccccccccccccccccccccccc' WHERE id = ${RUN_V2}`,
      ),
    ).rejects.toThrow(/immutable RunSpecV2 binding/i);
  });

  it("rejects moving a V2 run to another tenant", async () => {
    await expect(
      asSystem(
        (tx) =>
          tx`UPDATE agent.agent_runs SET org_id = ${ORG_B}, workspace_id = ${WS_B} WHERE id = ${RUN_V2}`,
      ),
    ).rejects.toThrow(/immutable RunSpecV2 binding/i);
  });

  it("rejects rewinding a monotonic counter", async () => {
    await expect(
      asSystem(
        (tx) =>
          tx`UPDATE agent.agent_runs SET next_run_seq = 1 WHERE id = ${RUN_V2}`,
      ),
    ).rejects.toThrow(/monotonic counter rewound/i);
  });

  it("refuses to upgrade a preserved V1 run to V2", async () => {
    // Relabelling history as trusted is exactly what the expand-only rule
    // forbids: the row has no principal, repository, or retention binding that
    // anyone ever verified.
    await expect(
      asSystem(
        (tx) =>
          tx`UPDATE agent.agent_runs SET spec_version = 2 WHERE id = ${RUN_V1}`,
      ),
    ).rejects.toThrow(/cannot be upgraded to spec_version/i);
  });

  it("leaves a preserved V1 run freely updatable", async () => {
    const rows = await asSystem(
      (tx) => tx<{ status: string }[]>`
        UPDATE agent.agent_runs SET status = 'running', claimed_by = 'legacy-worker'
        WHERE id = ${RUN_V1} RETURNING status
      `,
    );
    expect(rows[0]?.status).toBe("running");
  });
});
