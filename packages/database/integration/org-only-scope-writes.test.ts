/**
 * The org-only scope and the workspace GUC (#3029, ADR-068).
 *
 * A surface that has an organization but no workspace enters the kernel with
 * `ORG_ONLY_WORKSPACE_ID` — the nil uuid — as its scope's workspace: the app's
 * Organization pages (`apps/app/src/server/kernel.ts`) and the API's org-only
 * mount (`apps/api/src/lib/context.ts`). `withTenantDb` copies that value into
 * `app.current_workspace_id`.
 *
 * ADR-068 justified the sentinel on the tables an org-only call was expected to
 * touch — `workspace.workspaces`, `iam.roles`, `iam.role_grants` — all `org_only`
 * in POLICY_MANIFEST, and all of which genuinely ignore the workspace GUC. Two
 * writes reachable from an org-only scope do not stay inside that set:
 *
 *   • `update_workspace_settings` inserts into `workspace.workspace_slug_history`
 *     on every slug change. That table is `standard`.
 *   • `create_workspace` bootstraps `workspace.workspace_users` (`workspace_only`),
 *     `agent.agents` and `environments.environments` (`standard`).
 *
 * `standard` and `workspace_only` policies compare the row's `workspace_id`
 * against `app.current_workspace_id`, so under the sentinel every one of those
 * INSERTs is refused with SQLSTATE 42501. It is NOT 23505, so it escapes the
 * `isUniqueViolation` classifiers those handlers catch and surfaces as a 500.
 *
 * This suite is the witness. The "refused" cases are what today's org-only
 * callers would hit; the "accepted" cases are the same statements after the fix
 * re-points the workspace scope onto the target workspace — which is what
 * `workspace.settings.write` (runInTenantScope) and `workspace-bootstrap`
 * (setTransactionWorkspaceScope) now do.
 *
 * Superuser and RLS: a superuser bypasses RLS even under FORCE, so every
 * assertion runs as a purpose-built non-superuser role via SET LOCAL ROLE,
 * exactly like rls.test.ts. The superuser session seeds and cleans up.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

/** The value `apps/app` and `apps/api` pass when no workspace is in scope. */
const ORG_ONLY_WORKSPACE_ID = "00000000-0000-0000-0000-000000000000";

const ORG = "00000000-0000-0000-0021-000000000001";
const WS = "00000000-0000-0000-0022-000000000001";
/** `workspace.workspace_users.user_id` carries no FK, so no user row is needed. */
const USER = "00000000-0000-0000-0023-000000000001";

const APP_ROLE = "org_only_scope_test_role";

/** Postgres raises insufficient_privilege for a WITH CHECK a row fails. */
const RLS_REFUSAL = "42501";

beforeAll(async () => {
  await sql.unsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
        CREATE ROLE "${APP_ROLE}" NOLOGIN NOSUPERUSER;
      END IF;
    END$$
  `);
  await sql.unsafe(`GRANT USAGE ON SCHEMA workspace TO "${APP_ROLE}"`);
  await sql.unsafe(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON workspace.workspaces TO "${APP_ROLE}"`,
  );
  await sql.unsafe(
    `GRANT SELECT, INSERT, DELETE ON workspace.workspace_slug_history TO "${APP_ROLE}"`,
  );
  await sql.unsafe(
    `GRANT SELECT, INSERT, DELETE ON workspace.workspace_users TO "${APP_ROLE}"`,
  );

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO org.organizations
        (id, public_id, name, slug, namespace, plan_type, status, type)
      VALUES
        (${ORG}, 'oos_org', 'OrgOnly Org', 'oos-org', 'oosa', 'free', 'active', 'business')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO workspace.workspaces
        (id, public_id, org_id, name, slug, namespace)
      VALUES
        (${WS}, 'oos_ws', ${ORG}, 'OrgOnly WS', 'oos-ws', 'ooswa')
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`DELETE FROM workspace.workspace_slug_history WHERE org_id = ${ORG}`;
    await tx`DELETE FROM workspace.workspace_users WHERE workspace_id = ${WS}`;
    await tx`DELETE FROM workspace.workspaces WHERE org_id = ${ORG}`;
    await tx`DELETE FROM org.organizations WHERE id = ${ORG}`;
  });
  await sql
    .unsafe(`REVOKE ALL ON workspace.workspace_slug_history FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE ALL ON workspace.workspace_users FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE ALL ON workspace.workspaces FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql
    .unsafe(`REVOKE USAGE ON SCHEMA workspace FROM "${APP_ROLE}"`)
    .catch(() => undefined);
  await sql.unsafe(`DROP ROLE IF EXISTS "${APP_ROLE}"`).catch(() => undefined);
  await sql.end({ timeout: 5 });
});

/** One transaction, non-superuser, policies live, in the scope named. */
async function inScope<T>(
  orgId: string,
  workspaceId: string,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${orgId},      true),
        set_config('app.current_workspace_id', ${workspaceId}, true),
        set_config('app.rls_bypass',           'off',          true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

/** The SQLSTATE and message of a write the policy refused. */
const refusalOf = async (
  p: Promise<unknown>,
): Promise<{ code: string; message: string }> => {
  const err: unknown = await p.then(
    () => null,
    (e: unknown) => e,
  );
  if (err === null) throw new Error("expected the write to be refused");
  const { code, message } = err as { code?: string; message?: string };
  return { code: String(code), message: String(message) };
};

const insertSlugHistory = (tx: postgres.TransactionSql, newSlug: string) =>
  tx`
    INSERT INTO workspace.workspace_slug_history
      (public_id, org_id, workspace_id, old_slug, new_slug)
    VALUES (${`wsh_${newSlug}`}, ${ORG}, ${WS}, 'oos-ws', ${newSlug})
  `;

const insertMembership = (tx: postgres.TransactionSql, publicId: string) =>
  tx`
    INSERT INTO workspace.workspace_users
      (public_id, workspace_id, user_id, role, joined_at)
    VALUES (${publicId}, ${WS}, ${USER}, 'owner', now())
  `;

describe("an org-only scope and the tables an org-only write reaches", () => {
  // The claim ADR-068 rests on, held here so a re-baseline that changes a
  // policy class cannot quietly falsify the ADR.
  it("reads and writes workspace.workspaces, which is org_only and ignores the workspace GUC", async () => {
    const rows = await inScope(ORG, ORG_ONLY_WORKSPACE_ID, async (tx) => {
      await tx`
        UPDATE workspace.workspaces SET name = 'OrgOnly WS renamed' WHERE id = ${WS}
      `;
      return tx<{ id: string }[]>`
        SELECT id FROM workspace.workspaces WHERE org_id = ${ORG}
      `;
    });
    expect(rows.map((r) => r.id)).toEqual([WS]);
  });

  // #3029, the update_workspace_settings half. A name-only edit works, which is
  // why this went unnoticed; the re-slug the action promises does not.
  it("refuses the slug-history INSERT with 42501: workspace_slug_history is standard, not org_only", async () => {
    const { code, message } = await refusalOf(
      inScope(ORG, ORG_ONLY_WORKSPACE_ID, (tx) =>
        insertSlugHistory(tx, "oos-ws-renamed"),
      ),
    );
    expect(code).toBe(RLS_REFUSAL);
    expect(message).toMatch(/row-level security/i);
    // Not a unique violation, so `isUniqueViolation` never sees it and the
    // handler's slug_taken catch cannot classify it — it reaches the caller raw.
    expect(code).not.toBe("23505");
  });

  // #3029, the create_workspace half: the first row the bootstrap writes after
  // the workspace itself.
  it("refuses the workspace-membership INSERT with 42501: workspace_users is workspace_only", async () => {
    const { code, message } = await refusalOf(
      inScope(ORG, ORG_ONLY_WORKSPACE_ID, (tx) =>
        insertMembership(tx, "wsu_denied"),
      ),
    );
    expect(code).toBe(RLS_REFUSAL);
    expect(message).toMatch(/row-level security/i);
  });

  // The fix, both halves: the same statements under the TARGET workspace's
  // scope, which is what runInTenantScope (settings write) and
  // setTransactionWorkspaceScope (bootstrap) put the write in.
  it("accepts both writes once the scope names the target workspace", async () => {
    const written = await inScope(ORG, WS, async (tx) => {
      await insertSlugHistory(tx, "oos-ws-accepted");
      await insertMembership(tx, "wsu_accepted");
      const [history] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM workspace.workspace_slug_history
        WHERE workspace_id = ${WS}
      `;
      const [members] = await tx<{ n: string }[]>`
        SELECT count(*)::text AS n FROM workspace.workspace_users
        WHERE workspace_id = ${WS}
      `;
      return { history: history?.n, members: members?.n };
    });
    expect(written).toEqual({ history: "1", members: "1" });
  });
});
