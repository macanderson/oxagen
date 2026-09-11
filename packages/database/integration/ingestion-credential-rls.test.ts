/**
 * Ingestion credential RLS — the three child tables that hold secrets.
 *
 * ingestion.auth_credentials, ingestion.oauth_tokens and
 * ingestion.webhook_subscriptions carry no org_id and no workspace_id, so
 * manifest-coverage.test.ts never asks about them and POLICY_MANIFEST has no
 * class that fits. They shipped with no RLS at all on the premise, written into
 * drizzle/0029_ingestion_rls.sql, that "their isolation is transitive through
 * source_connections". Postgres RLS is not transitive: a query naming
 * ingestion.oauth_tokens alone evaluates that relation's policies and no
 * others.
 *
 * 20260910120000_ingestion_credential_rls.sql makes the transitivity real by
 * predicating each child on its parent being visible. This suite is what holds
 * it there — drop the policies and every assertion below fails.
 *
 * Superuser and RLS: a superuser bypasses RLS even under FORCE, so the
 * isolation assertions run as a purpose-built non-superuser role via SET LOCAL
 * ROLE, exactly like rls.test.ts. The superuser session seeds and cleans up.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const ORG_A = "00000000-0000-0000-0011-000000000001";
const ORG_B = "00000000-0000-0000-0011-000000000002";
const WS_A = "00000000-0000-0000-0012-000000000001";
const WS_B = "00000000-0000-0000-0012-000000000002";
const CONN_A = "00000000-0000-0000-0013-000000000001";
const CONN_B = "00000000-0000-0000-0013-000000000002";

const APP_ROLE = "ingestion_rls_test_role";

/** The three tables under test, and the child column each policy joins on. */
const CREDENTIAL_TABLES = [
  "auth_credentials",
  "oauth_tokens",
  "webhook_subscriptions",
] as const;

beforeAll(async () => {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE "${APP_ROLE}" NOLOGIN NOSUPERUSER;
      END IF;
    END$$
  `);
  await sql.unsafe(`GRANT USAGE ON SCHEMA ingestion TO "${APP_ROLE}"`);
  // SELECT on the parent is what the child policies' subquery needs; without it
  // the policy errors rather than filtering.
  await sql.unsafe(
    `GRANT SELECT ON ingestion.source_connections TO "${APP_ROLE}"`,
  );
  for (const t of CREDENTIAL_TABLES) {
    await sql.unsafe(
      `GRANT SELECT, INSERT, DELETE ON ingestion.${t} TO "${APP_ROLE}"`,
    );
  }

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;

    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG_A}, 'icred_org_a', 'ICred Org A', 'icred-org-a', 'icra', 'free', 'active', 'business'),
        (${ORG_B}, 'icred_org_b', 'ICred Org B', 'icred-org-b', 'icrb', 'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_A}, 'icred_ws_a', ${ORG_A}, 'ICred WS A', 'icred-ws-a', 'icwa'),
        (${WS_B}, 'icred_ws_b', ${ORG_B}, 'ICred WS B', 'icred-ws-b', 'icwb')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO ingestion.source_connections
        (id, public_id, org_id, workspace_id, connector_id, display_name, auth_scheme, delivery_method, status)
      VALUES
        (${CONN_A}, 'icred_conn_a', ${ORG_A}, ${WS_A}, 'github', 'A conn', 'oauth2', 'webhook', 'connected'),
        (${CONN_B}, 'icred_conn_b', ${ORG_B}, ${WS_B}, 'github', 'B conn', 'oauth2', 'webhook', 'connected')
      ON CONFLICT (id) DO NOTHING
    `;

    // One credential row per org in each of the three tables. The secret values
    // are the shape the app stores (an encryption envelope), not real material.
    const envelope = JSON.stringify({ keyId: "env:v1", ciphertext: "Zm9v" });
    await tx`
      INSERT INTO ingestion.auth_credentials (connection_id, auth_scheme, encrypted_payload)
      VALUES (${CONN_A}, 'api_key', ${envelope}::jsonb),
             (${CONN_B}, 'api_key', ${envelope}::jsonb)
      ON CONFLICT (connection_id) DO NOTHING
    `;
    await tx`
      INSERT INTO ingestion.oauth_tokens (connection_id, access_token_enc)
      VALUES (${CONN_A}, ${envelope}::jsonb),
             (${CONN_B}, ${envelope}::jsonb)
      ON CONFLICT (connection_id) DO NOTHING
    `;
    await tx`
      INSERT INTO ingestion.webhook_subscriptions (public_id, connection_id, webhook_path)
      VALUES ('icred_whs_a', ${CONN_A}, '/api/v1/webhooks/github/icred-a'),
             ('icred_whs_b', ${CONN_B}, '/api/v1/webhooks/github/icred-b')
      ON CONFLICT DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    // ON DELETE CASCADE from source_connections takes the three child rows.
    await tx`DELETE FROM ingestion.source_connections WHERE id IN (${CONN_A}, ${CONN_B})`;
    await tx`DELETE FROM workspace.workspaces WHERE id IN (${WS_A}, ${WS_B})`;
    await tx`DELETE FROM org.organizations WHERE id IN (${ORG_A}, ${ORG_B})`;
  });

  for (const t of CREDENTIAL_TABLES) {
    await sql
      .unsafe(`REVOKE ALL ON ingestion.${t} FROM "${APP_ROLE}"`)
      .catch(() => undefined);
  }
  await sql
    .unsafe(`REVOKE ALL ON ingestion.source_connections FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA ingestion FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);

  await sql.end({ timeout: 5 });
});

/** Run inside a non-superuser transaction scoped to one tenant, bypass off. */
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

describe("ingestion credential tables carry RLS", () => {
  it.each(CREDENTIAL_TABLES)(
    "ingestion.%s has ENABLE + FORCE row level security",
    async (table) => {
      const rows = await sql<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >`
        SELECT c.relrowsecurity, c.relforcerowsecurity
        FROM   pg_class c
        JOIN   pg_namespace n ON n.oid = c.relnamespace
        WHERE  n.nspname = 'ingestion' AND c.relname = ${table}
      `;
      expect(rows[0]?.relrowsecurity, `${table} ENABLE`).toBe(true);
      expect(rows[0]?.relforcerowsecurity, `${table} FORCE`).toBe(true);
    },
  );

  it.each(CREDENTIAL_TABLES)(
    "ingestion.%s carries a tenant_isolation policy",
    async (table) => {
      const rows = await sql<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'ingestion' AND tablename = ${table}
      `;
      expect(rows.map((r) => r.policyname)).toContain("tenant_isolation");
    },
  );
});

describe("ingestion credential isolation (non-superuser, bypass off)", () => {
  // The headline proof, and the exact query the finding describes: no join to
  // source_connections, so the policy is the only thing standing between org A
  // and org B's encrypted OAuth material.
  it.each(CREDENTIAL_TABLES)(
    "an UNJOINED read of ingestion.%s returns only the active org's row",
    async (table) => {
      const rows = await asTenant(ORG_A, WS_A, (tx) =>
        tx.unsafe<{ connection_id: string }[]>(
          `SELECT connection_id FROM ingestion.${table}`,
        ),
      );
      expect(rows.map((r) => r.connection_id)).toEqual([CONN_A]);
    },
  );

  it.each(CREDENTIAL_TABLES)(
    "an explicit read of the other org's ingestion.%s row returns nothing",
    async (table) => {
      const rows = await asTenant(ORG_A, WS_A, (tx) =>
        tx.unsafe(
          `SELECT 1 FROM ingestion.${table} WHERE connection_id = '${CONN_B}'`,
        ),
      );
      expect(rows.length).toBe(0);
    },
  );

  it("WITH CHECK refuses a credential written against another org's connection", async () => {
    await expect(
      asTenant(ORG_A, WS_A, (tx) =>
        tx.unsafe(`
          INSERT INTO ingestion.oauth_tokens (connection_id, access_token_enc)
          VALUES ('${CONN_B}', '{"keyId":"env:v1","ciphertext":"YmFy"}'::jsonb)
          ON CONFLICT (connection_id) DO NOTHING
        `),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  // The reason this migration does not use the bypass-only shape that
  // ratelimit.rate_limit_counters uses: connection.create, connection.preview
  // and ingestion.delete all reach these tables inside withTenantDb, where
  // bypass is off. A default-deny policy would not fail closed there — the
  // DELETE would match nothing and report success, stranding the credentials.
  it("a tenant session can still write and delete its own connection's credential", async () => {
    const deleted = await asTenant(ORG_A, WS_A, async (tx) => {
      await tx.unsafe(`
        INSERT INTO ingestion.webhook_subscriptions (public_id, connection_id, webhook_path)
        VALUES ('icred_whs_a2', '${CONN_A}', '/api/v1/webhooks/github/icred-a2')
      `);
      return tx.unsafe(`
        DELETE FROM ingestion.webhook_subscriptions
        WHERE public_id = 'icred_whs_a2'
        RETURNING public_id
      `);
    });
    expect(deleted.length).toBe(1);
  });
});
