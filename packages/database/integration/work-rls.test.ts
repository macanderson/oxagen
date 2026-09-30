/**
 * work.* RLS: one org never reads or writes another org's work records.
 *
 * 20260929000000_work_schema.sql creates ten tables in the work schema, from
 * collectors and work items to done records and training exports. Each one
 * forces RLS and carries two policies: tenant_isolation (org and workspace
 * must match the GUCs) and tenant_org_wide_read (org must match when
 * app.org_wide is on). manifest-coverage.test.ts proves the policies exist.
 * This suite proves what they do with rows in them.
 *
 * Two orgs each get one row in every table (two work items, so an item link
 * has both ends). Every read asks for the seeded ids of both orgs and asserts
 * the exact set that comes back, so a policy that leaks, and a policy that
 * hides an org's own rows, both fail. Counting rows would pass on a database
 * that happens to hold nothing.
 *
 * Superuser and RLS: a superuser bypasses RLS even under FORCE, so every
 * assertion runs as the real `oxagen_app` role via SET LOCAL ROLE, like
 * rls.test.ts. It sees the grants the work migration installs. Nothing here
 * deletes from work.items, or updates or deletes work.done_verdicts or
 * work.autonomy_events, as oxagen_app. The migration withholds those grants,
 * so the statement would fail on the grant before RLS ran. The superuser
 * session seeds, checks, and cleans up, with app.rls_bypass on.
 *
 * No org or workspace rows are seeded. No work table has a foreign key to
 * either, and the policies compare org_id and workspace_id with the GUCs
 * alone.
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

/** A fixed id in this suite's reserved block. Blocks 0061 to 006c are unused elsewhere in integration/. */
function id(block: string, n: number): string {
  return `00000000-0000-0000-${block}-${String(n).padStart(12, "0")}`;
}

const ORG_A = id("0061", 1);
const ORG_B = id("0061", 2);
const WS_A1 = id("0062", 1);
const WS_A2 = id("0062", 2);
const WS_B = id("0062", 3);

const DIGEST = `sha256:${"0".repeat(64)}`;

const WORK_TABLES = [
  "work.collectors",
  "work.inbound_events",
  "work.items",
  "work.item_links",
  "work.triage_decisions",
  "work.triage_corrections",
  "work.done_records",
  "work.done_verdicts",
  "work.autonomy_events",
  "work.training_exports",
] as const;
type WorkTable = (typeof WORK_TABLES)[number];

/** Children before parents, so a delete never trips a foreign key. */
const CLEANUP_ORDER: readonly WorkTable[] = [
  "work.triage_corrections",
  "work.triage_decisions",
  "work.done_records",
  "work.item_links",
  "work.inbound_events",
  "work.items",
  "work.collectors",
  "work.done_verdicts",
  "work.autonomy_events",
  "work.training_exports",
];

type Tenant = {
  key: "a" | "b";
  org: string;
  workspace: string;
  rows: Record<WorkTable, readonly string[]>;
};

/** The ids one tenant owns, per table. Tenant n takes id n, and work items 2n-1 and 2n. */
function tenant(key: "a" | "b", n: 1 | 2, org: string, workspace: string): Tenant {
  return {
    key,
    org,
    workspace,
    rows: {
      "work.collectors": [id("0063", n)],
      "work.items": [id("0064", 2 * n - 1), id("0064", 2 * n)],
      "work.inbound_events": [id("0065", n)],
      "work.item_links": [id("0066", n)],
      "work.triage_decisions": [id("0067", n)],
      "work.triage_corrections": [id("0068", n)],
      "work.done_records": [id("0069", n)],
      "work.done_verdicts": [id("006a", n)],
      "work.autonomy_events": [id("006b", n)],
      "work.training_exports": [id("006c", n)],
    },
  };
}

const A = tenant("a", 1, ORG_A, WS_A1);
const B = tenant("b", 2, ORG_B, WS_B);

function one(t: Tenant, table: WorkTable): string {
  return t.rows[table][0]!;
}

/** Insert one row per work table for a tenant, parents first. */
async function seedTenant(tx: postgres.TransactionSql, t: Tenant): Promise<void> {
  const [itemFrom, itemTo] = t.rows["work.items"] as [string, string];
  await tx`
    INSERT INTO work.collectors (id, org_id, workspace_id, name, type, file_hash)
    VALUES (${one(t, "work.collectors")}, ${t.org}, ${t.workspace}, ${`rls-proof-${t.key}`}, 'github', 'rls-proof')
  `;
  await tx`
    INSERT INTO work.items (id, public_id, org_id, workspace_id, number, subject, origin)
    VALUES
      (${itemFrom}, ${`wi_rlsproof_${t.key}1`}, ${t.org}, ${t.workspace}, ${`RLS-${t.key}-1`}, 'RLS proof work item', 'manual'),
      (${itemTo},   ${`wi_rlsproof_${t.key}2`}, ${t.org}, ${t.workspace}, ${`RLS-${t.key}-2`}, 'RLS proof work item', 'manual')
  `;
  await tx`
    INSERT INTO work.inbound_events (id, org_id, workspace_id, collector_id, delivery_id, cloudevent)
    VALUES (${one(t, "work.inbound_events")}, ${t.org}, ${t.workspace}, ${one(t, "work.collectors")}, ${`rls-proof-${t.key}`}, '{}'::jsonb)
  `;
  await tx`
    INSERT INTO work.item_links (id, org_id, workspace_id, from_id, to_id, kind, "by")
    VALUES (${one(t, "work.item_links")}, ${t.org}, ${t.workspace}, ${itemFrom}, ${itemTo}, 'related', 'rls-proof')
  `;
  await tx`
    INSERT INTO work.triage_decisions
      (id, public_id, org_id, workspace_id, item_id, output, model, prompt_digest, priorities_hash, input_digest)
    VALUES
      (${one(t, "work.triage_decisions")}, ${`td_rlsproof_${t.key}`}, ${t.org}, ${t.workspace}, ${itemFrom},
       '{}'::jsonb, 'rls-proof', ${DIGEST}, ${DIGEST}, ${DIGEST})
  `;
  await tx`
    INSERT INTO work.triage_corrections (id, org_id, workspace_id, decision_id, field, "by")
    VALUES (${one(t, "work.triage_corrections")}, ${t.org}, ${t.workspace}, ${one(t, "work.triage_decisions")}, 'priority', 'rls-proof')
  `;
  await tx`
    INSERT INTO work.done_records (id, org_id, workspace_id, digest, item_id, body, locked_by, locked_at)
    VALUES (${one(t, "work.done_records")}, ${t.org}, ${t.workspace}, ${DIGEST}, ${itemFrom}, '{}'::jsonb, 'rls-proof', now())
  `;
  await tx`
    INSERT INTO work.done_verdicts (id, org_id, workspace_id, record_digest, verdict)
    VALUES (${one(t, "work.done_verdicts")}, ${t.org}, ${t.workspace}, ${DIGEST}, 'pending')
  `;
  await tx`
    INSERT INTO work.autonomy_events (id, org_id, workspace_id, scope, to_level, cause, "by")
    VALUES (${one(t, "work.autonomy_events")}, ${t.org}, ${t.workspace}, '{}'::jsonb, 0, 'steering_pr', 'rls-proof')
  `;
  await tx`
    INSERT INTO work.training_exports (id, org_id, workspace_id, consent_hash, count, positive, negative, digest)
    VALUES (${one(t, "work.training_exports")}, ${t.org}, ${t.workspace}, ${DIGEST}, 0, 0, 0, ${DIGEST})
  `;
}

/** Delete every seeded row of both tenants. Safe to run on an empty database. */
async function cleanup(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    for (const table of CLEANUP_ORDER) {
      const ids = [...A.rows[table], ...B.rows[table]];
      await tx`DELETE FROM ${tx(table)} WHERE id IN ${tx(ids)}`;
    }
  });
}

beforeAll(async () => {
  // Require the migrated role. A role this suite granted for itself would
  // prove only its own grants.
  const [role] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!role?.exists) {
    throw new Error("work RLS proof requires the migrated oxagen_app role");
  }

  // A run that died before afterAll leaves its rows. Clear them so the unique
  // indexes do not refuse the seed.
  await cleanup();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    await seedTenant(tx, A);
    await seedTenant(tx, B);
  });
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
});

type Scope = { org: string; workspace: string; orgWide?: "on" | "off"; bypass?: "on" | "off" };

/** Run fn as oxagen_app with the tenant GUCs set for this transaction only. */
async function inScope<T>(gucs: Scope, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
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

const TENANT_A: Scope = { org: ORG_A, workspace: WS_A1 };
const TENANT_A_OTHER_WS: Scope = { org: ORG_A, workspace: WS_A2 };
const ORG_WIDE_A: Scope = { org: ORG_A, workspace: "", orgWide: "on" };
const TENANT_B: Scope = { org: ORG_B, workspace: WS_B };
const ORG_WIDE_B: Scope = { org: ORG_B, workspace: "", orgWide: "on" };
const NO_SCOPE: Scope = { org: "", workspace: "" };

/** The seeded ids of both tenants that a scope can read from one table, sorted. */
async function visibleIds(scope: Scope, table: WorkTable): Promise<string[]> {
  const ids = [...A.rows[table], ...B.rows[table]];
  const rows = await inScope(scope, (tx) =>
    tx<{ id: string }[]>`SELECT id::text AS id FROM ${tx(table)} WHERE id IN ${tx(ids)}`,
  );
  return rows.map((r) => r.id).sort();
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe.each(WORK_TABLES)("%s RLS", (table) => {
  it("shows org A its own rows in its workspace", async () => {
    expect(await visibleIds(TENANT_A, table)).toEqual(sorted(A.rows[table]));
  });

  it("shows org A its own rows under org-wide read", async () => {
    expect(await visibleIds(ORG_WIDE_A, table)).toEqual(sorted(A.rows[table]));
  });

  it("hides org A's rows from another workspace in org A", async () => {
    expect(await visibleIds(TENANT_A_OTHER_WS, table)).toEqual([]);
  });

  it("shows org B only its own rows", async () => {
    expect(await visibleIds(TENANT_B, table)).toEqual(sorted(B.rows[table]));
  });

  it("shows org B only its own rows under org-wide read", async () => {
    expect(await visibleIds(ORG_WIDE_B, table)).toEqual(sorted(B.rows[table]));
  });

  it("shows nothing when no tenant is set", async () => {
    expect(await visibleIds(NO_SCOPE, table)).toEqual([]);
  });
});

describe("work.* RLS writes", () => {
  it("refuses a work.collectors row that org B stamps with org A", async () => {
    await expect(
      inScope(TENANT_B, (tx) => tx`
        INSERT INTO work.collectors (id, org_id, workspace_id, name, type, file_hash)
        VALUES (${id("0063", 9)}, ${ORG_A}, ${WS_A1}, 'rls-proof-forged', 'github', 'rls-proof')
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses a work.done_verdicts row that org B stamps with org A", async () => {
    await expect(
      inScope(TENANT_B, (tx) => tx`
        INSERT INTO work.done_verdicts (id, org_id, workspace_id, record_digest, verdict)
        VALUES (${id("006a", 9)}, ${ORG_A}, ${WS_A1}, ${DIGEST}, 'pending')
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to move org B's collector into org A", async () => {
    await expect(
      inScope(TENANT_B, (tx) => tx`
        UPDATE work.collectors SET org_id = ${ORG_A}, workspace_id = ${WS_A1}
        WHERE id = ${one(B, "work.collectors")}
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("matches no org A row when org B updates or deletes it", async () => {
    const updatedCollector = await inScope(TENANT_B, (tx) => tx`
      UPDATE work.collectors SET name = 'rls-proof-hijacked'
      WHERE id = ${one(A, "work.collectors")} RETURNING id
    `);
    const updatedItem = await inScope(TENANT_B, (tx) => tx`
      UPDATE work.items SET subject = 'rls-proof-hijacked'
      WHERE id = ${one(A, "work.items")} RETURNING id
    `);
    const deletedCollector = await inScope(TENANT_B, (tx) => tx`
      DELETE FROM work.collectors WHERE id = ${one(A, "work.collectors")} RETURNING id
    `);
    const orgWideUpdate = await inScope(ORG_WIDE_B, (tx) => tx`
      UPDATE work.collectors SET name = 'rls-proof-hijacked'
      WHERE id = ${one(A, "work.collectors")} RETURNING id
    `);
    expect(updatedCollector).toHaveLength(0);
    expect(updatedItem).toHaveLength(0);
    expect(deletedCollector).toHaveLength(0);
    expect(orgWideUpdate).toHaveLength(0);

    const [collector, item] = await sql.begin(async (tx) => {
      await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
      const [c] = await tx<{ name: string }[]>`
        SELECT name FROM work.collectors WHERE id = ${one(A, "work.collectors")}
      `;
      const [i] = await tx<{ subject: string }[]>`
        SELECT subject FROM work.items WHERE id = ${one(A, "work.items")}
      `;
      return [c, i] as const;
    });
    expect(collector?.name).toBe("rls-proof-a");
    expect(item?.subject).toBe("RLS proof work item");
  });
});
