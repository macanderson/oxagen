/**
 * A tacho session uuid another workspace holds, under real row-level security
 * (#3944, audit finding S-03).
 *
 * `tacho.sessions` has one unique index on `session_uuid` across every tenant
 * (`tacho_sessions_session_uuid_uniq`), and `tenant_isolation` hides a row
 * outside the caller's workspace. Ingest reads the session, finds nothing,
 * inserts, and the INSERT conflicts with the hidden row. Ingest used to answer
 * that conflict 409 as a race, and the host retried it for ever. It now reads
 * the row once more and refuses a row it still cannot see as held by another
 * host (`tacho.events.ingest.ts`).
 *
 * This file proves the database half of that reasoning, which a fake database
 * cannot: after the conflict, the caller's workspace still reads nothing,
 * while the holder's own workspace, after the same conflict, reads its row.
 *
 * Superusers bypass row-level security, so each assertion drops to a
 * non-superuser role with SET LOCAL ROLE, as rls.test.ts does.
 *
 * CI: rls-integration job (TENANT_RLS_ENFORCEMENT_ENABLED=true, clean DB).
 * Local: DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *          pnpm --filter @oxagen/database test:integration
 */
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const RUN = randomBytes(2).toString("hex");
const ORG = randomUUID();
const WS_HOLDER = randomUUID();
const WS_CALLER = randomUUID();
const SESSION = randomUUID();
const APP_ROLE = "tacho_s03_test_app_role";

beforeAll(async () => {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE "${APP_ROLE}" NOLOGIN NOSUPERUSER;
      END IF;
    END$$
  `);
  await sql.unsafe(`GRANT USAGE ON SCHEMA tacho TO "${APP_ROLE}"`);
  await sql.unsafe(`GRANT SELECT, INSERT ON tacho.sessions TO "${APP_ROLE}"`);

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, ${`s03_org_${RUN}`}, 'S-03 Org', ${`s03-org-${RUN}`}, ${`s${RUN}`}, 'free', 'active', 'business')
    `;
    await tx`
      INSERT INTO workspace.workspaces (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS_HOLDER}, ${`s03_wsh_${RUN}`}, ${ORG}, 'S-03 holder', ${`s03-wsh-${RUN}`}, ${`h${RUN}`}),
        (${WS_CALLER}, ${`s03_wsc_${RUN}`}, ${ORG}, 'S-03 caller', ${`s03-wsc-${RUN}`}, ${`c${RUN}`})
    `;
    await tx`
      INSERT INTO tacho.sessions
        (id, public_id, org_id, workspace_id, session_uuid, harness_session_id,
         agent_key, root_session_uuid, runtime, harness, started_at, last_event_at)
      VALUES
        (gen_random_uuid(), ${`tse_s03holder${RUN}`}, ${ORG}, ${WS_HOLDER}, ${SESSION}, 'held',
         'acme.core.holder', ${SESSION}, 'claude-code', 'claude-code', now(), now())
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM tacho.sessions WHERE org_id = ${ORG}`;
    await tx`DELETE FROM workspace.workspaces WHERE org_id = ${ORG}`;
    await tx`DELETE FROM org.organizations WHERE id = ${ORG}`;
  });
  await sql
    .unsafe(`REVOKE ALL ON tacho.sessions FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA tacho FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);
  await sql.end({ timeout: 5 });
});

/** A transaction as the app role, scoped to one workspace, with bypass off. */
async function asWorkspace<T>(
  workspaceId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id', ${ORG}, true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.org_wide', 'off', true),
        set_config('app.rls_bypass', 'off', true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

/** Ingest's three statements for a session it believes is new. */
async function readInsertRead(workspaceId: string) {
  return asWorkspace(workspaceId, async (tx) => {
    const before = await tx`
      SELECT id FROM tacho.sessions WHERE session_uuid = ${SESSION}
    `;
    const inserted = await tx`
      INSERT INTO tacho.sessions
        (id, public_id, org_id, workspace_id, session_uuid, harness_session_id,
         agent_key, root_session_uuid, runtime, harness, started_at, last_event_at)
      VALUES
        (gen_random_uuid(), ${`tse_s03${randomBytes(6).toString("hex")}`}, ${ORG}, ${workspaceId},
         ${SESSION}, 'claimed', 'acme.core.caller', ${SESSION}, 'claude-code', 'claude-code', now(), now())
      ON CONFLICT DO NOTHING
      RETURNING id
    `;
    const after = await tx`
      SELECT id FROM tacho.sessions WHERE session_uuid = ${SESSION}
    `;
    return {
      before: before.length,
      inserted: inserted.length,
      after: after.length,
    };
  });
}

describe("#3944 S-03: a session uuid another workspace holds", () => {
  it("stays unreadable to the caller's workspace after its INSERT conflicts", async () => {
    await expect(readInsertRead(WS_CALLER)).resolves.toEqual({
      before: 0,
      inserted: 0,
      after: 0,
    });
  });

  it("is readable to the workspace that holds it after the same conflict (negative)", async () => {
    await expect(readInsertRead(WS_HOLDER)).resolves.toEqual({
      before: 1,
      inserted: 0,
      after: 1,
    });
  });
});
