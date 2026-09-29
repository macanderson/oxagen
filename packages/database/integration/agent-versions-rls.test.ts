/**
 * agent.agent_versions RLS: version rows follow their agent's tenant.
 *
 * agent.agent_versions carries no org_id and no workspace_id, so
 * manifest-coverage.test.ts never asks about it and POLICY_MANIFEST has no
 * class that fits. It shipped with no RLS at all while its parent agent.agents
 * was policied. Postgres RLS is not transitive: a query naming
 * agent.agent_versions alone evaluates that relation's policies and no others.
 *
 * 20260929124500_agent_versions_rls.sql scopes each row through its agent and
 * mirrors the two policies on agent.agents. This suite holds it there. Drop
 * the policies and the isolation assertions below fail.
 *
 * Superuser and RLS: a superuser bypasses RLS even under FORCE, so every
 * assertion runs as the real `oxagen_app` role via SET LOCAL ROLE, like
 * rls.test.ts. It sees the grants the migrations install, including the SELECT
 * on agent.agents that the policy subquery needs. Missing role provisioning
 * fails. The superuser session seeds and cleans up.
 *
 * No org or workspace rows are seeded. agent.agents has no foreign key to
 * either table, and the policies compare the agent's org_id and workspace_id
 * with the GUCs alone.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

/**
 * The real application role. Non-superuser and no BYPASSRLS, so the policies
 * apply. The migrations create it, and beforeAll fails when it is missing.
 */
const APP_ROLE = "oxagen_app";

const ORG_A = "00000000-0000-0000-0051-000000000001";
const ORG_B = "00000000-0000-0000-0051-000000000002";
const WS_A1 = "00000000-0000-0000-0052-000000000001";
const WS_A2 = "00000000-0000-0000-0052-000000000002";
const WS_B = "00000000-0000-0000-0052-000000000003";
const AGENT_A1 = "00000000-0000-0000-0053-000000000001";
const AGENT_A2 = "00000000-0000-0000-0053-000000000002";
const AGENT_B = "00000000-0000-0000-0053-000000000003";
const VERSION_A1 = "00000000-0000-0000-0054-000000000001";
const VERSION_A2 = "00000000-0000-0000-0054-000000000002";
const VERSION_B = "00000000-0000-0000-0054-000000000003";
const USER = "00000000-0000-0000-0055-000000000001";

beforeAll(async () => {
  // Require the migrated role. A role this suite granted for itself would
  // prove only its own grants, and the policy subquery errors rather than
  // filters when the role lacks SELECT on agent.agents.
  const [role] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!role?.exists) {
    throw new Error("agent_versions RLS proof requires the migrated oxagen_app role");
  }

  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await tx`
      INSERT INTO agent.agents
        (id, public_id, org_id, workspace_id, slug, name, agent_type)
      VALUES
        (${AGENT_A1}, 'agt_avrls_a1', ${ORG_A}, ${WS_A1}, 'avrls-a1', 'AVRLS A1', 'custom'),
        (${AGENT_A2}, 'agt_avrls_a2', ${ORG_A}, ${WS_A2}, 'avrls-a2', 'AVRLS A2', 'custom'),
        (${AGENT_B},  'agt_avrls_b',  ${ORG_B}, ${WS_B},  'avrls-b',  'AVRLS B',  'custom')
      ON CONFLICT (id) DO NOTHING
    `;
    await tx`
      INSERT INTO agent.agent_versions (id, agent_id, version, created_by_id)
      VALUES
        (${VERSION_A1}, ${AGENT_A1}, 1, ${USER}),
        (${VERSION_A2}, ${AGENT_A2}, 1, ${USER}),
        (${VERSION_B},  ${AGENT_B},  1, ${USER})
      ON CONFLICT (id) DO NOTHING
    `;
  });
});

afterAll(async () => {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    // Versions first: the foreign key to agents is NO ACTION.
    await tx`
      DELETE FROM agent.agent_versions
      WHERE agent_id IN (${AGENT_A1}, ${AGENT_A2}, ${AGENT_B})
    `;
    await tx`
      DELETE FROM agent.agents WHERE id IN (${AGENT_A1}, ${AGENT_A2}, ${AGENT_B})
    `;
  });
  await sql.end({ timeout: 5 });
});

/** The four GUCs the tenant helpers set. Absent flags read as off. */
type Scope = {
  org: string;
  workspace: string;
  orgWide?: "on" | "off";
  bypass?: "on" | "off";
};

/** One transaction as the app role, policies live, GUCs as named. */
async function inScope<T>(
  gucs: Scope,
  fn: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${gucs.org},              true),
        set_config('app.current_workspace_id', ${gucs.workspace},        true),
        set_config('app.org_wide',             ${gucs.orgWide ?? "off"}, true),
        set_config('app.rls_bypass',           ${gucs.bypass ?? "off"},  true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

/** Workspace A1 of org A, the way withTenantDb scopes it. */
const TENANT_A1: Scope = { org: ORG_A, workspace: WS_A1 };
/** Org A as withOrgDb scopes it: empty workspace GUC, org-wide read on. */
const ORG_WIDE_A: Scope = { org: ORG_A, workspace: "", orgWide: "on" };

/** The seeded version ids the scope can read, sorted. */
async function visibleVersions(gucs: Scope) {
  const rows = await inScope(gucs, (tx) =>
    tx<{ id: string }[]>`
      SELECT id FROM agent.agent_versions
      WHERE agent_id IN (${AGENT_A1}, ${AGENT_A2}, ${AGENT_B})
      ORDER BY id
    `,
  );
  return rows.map((r) => r.id);
}

describe("agent.agent_versions carries RLS", () => {
  it("has ENABLE and FORCE row level security", async () => {
    const rows = await sql<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`
      SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM   pg_class c
      JOIN   pg_namespace n ON n.oid = c.relnamespace
      WHERE  n.nspname = 'agent' AND c.relname = 'agent_versions'
    `;
    expect(rows[0]?.relrowsecurity, "ENABLE").toBe(true);
    expect(rows[0]?.relforcerowsecurity, "FORCE").toBe(true);
  });

  it("carries the tenant_isolation and tenant_org_wide_read policies", async () => {
    const rows = await sql<{ policyname: string }[]>`
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'agent' AND tablename = 'agent_versions'
      ORDER BY policyname
    `;
    expect(rows.map((r) => r.policyname)).toEqual([
      "tenant_isolation",
      "tenant_org_wide_read",
    ]);
  });
});

describe("agent.agent_versions isolation (oxagen_app, bypass off)", () => {
  // The headline proof: no join to agent.agents, so the policy is the only
  // thing between workspace A1 and every other tenant's version rows.
  it("an unjoined read returns only the current workspace's rows", async () => {
    expect(await visibleVersions(TENANT_A1)).toEqual([VERSION_A1]);
  });

  it("an explicit read of another org's row returns nothing", async () => {
    const rows = await inScope(TENANT_A1, (tx) =>
      tx`SELECT 1 FROM agent.agent_versions WHERE id = ${VERSION_B}`,
    );
    expect(rows.length).toBe(0);
  });

  it("a session with no tenant scope reads nothing", async () => {
    expect(await visibleVersions({ org: "", workspace: "" })).toEqual([]);
  });

  it("WITH CHECK refuses a version written against another org's agent", async () => {
    await expect(
      inScope(TENANT_A1, (tx) =>
        tx`
          INSERT INTO agent.agent_versions (agent_id, version, created_by_id)
          VALUES (${AGENT_B}, 2, ${USER})
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an UPDATE of another org's row matches nothing", async () => {
    const updated = await inScope(TENANT_A1, (tx) =>
      tx`
        UPDATE agent.agent_versions SET is_published = true
        WHERE id = ${VERSION_B}
        RETURNING id
      `,
    );
    expect(updated.length).toBe(0);
  });

  it("a DELETE of another org's row matches nothing", async () => {
    const deleted = await inScope(TENANT_A1, (tx) =>
      tx`DELETE FROM agent.agent_versions WHERE id = ${VERSION_B} RETURNING id`,
    );
    expect(deleted.length).toBe(0);
    expect(await visibleVersions({ ...TENANT_A1, bypass: "on" })).toContain(
      VERSION_B,
    );
  });

  // The reason the policy is not bypass-only: writeAgentVersion and
  // bootstrapWorkspaceAgents write this table inside withTenantDb.
  it("a tenant session can still write and delete its own agent's version", async () => {
    const deleted = await inScope(TENANT_A1, async (tx) => {
      await tx`
        INSERT INTO agent.agent_versions (agent_id, version, created_by_id)
        VALUES (${AGENT_A1}, 2, ${USER})
      `;
      return tx`
        DELETE FROM agent.agent_versions
        WHERE agent_id = ${AGENT_A1} AND version = 2
        RETURNING id
      `;
    });
    expect(deleted.length).toBe(1);
  });

  it("the bypass still reads every tenant's rows", async () => {
    expect(await visibleVersions({ ...TENANT_A1, bypass: "on" })).toEqual([
      VERSION_A1,
      VERSION_A2,
      VERSION_B,
    ]);
  });
});

describe("agent.agent_versions org-wide read (oxagen_app, bypass off)", () => {
  it("reads every workspace of the org and no other org", async () => {
    expect(await visibleVersions(ORG_WIDE_A)).toEqual([VERSION_A1, VERSION_A2]);
  });

  // The assertion that tells this policy apart from a bare "the parent is
  // visible" EXISTS. Under org-wide read, agent.agents' own FOR SELECT policy
  // makes A2's agent visible to the subquery, so only the explicit workspace
  // predicate keeps the write fenced.
  it("refuses a version written in another workspace of the org", async () => {
    await expect(
      inScope(ORG_WIDE_A, (tx) =>
        tx`
          INSERT INTO agent.agent_versions (agent_id, version, created_by_id)
          VALUES (${AGENT_A2}, 2, ${USER})
        `,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("an org-wide DELETE matches nothing", async () => {
    const deleted = await inScope(ORG_WIDE_A, (tx) =>
      tx`DELETE FROM agent.agent_versions WHERE id = ${VERSION_A2} RETURNING id`,
    );
    expect(deleted.length).toBe(0);
  });
});
