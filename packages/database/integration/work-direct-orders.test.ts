/**
 * Work order capture against a migrated database (F13, #4638, migration
 * 20261002060000_work_direct_orders.sql):
 *
 *   - work.direct_orders and work.done_checks keep each tenant's rows to that
 *     tenant, as oxagen_app, for reads and writes
 *   - a direct work order's run never changes, and its work item, attach time,
 *     and attacher move together once, to a work item in its own workspace
 *   - a check run is append only, and its result follows its verdict
 *   - a run_totals row names its work order and that work order's kind together
 *
 * Every assertion runs as the real oxagen_app role via SET LOCAL ROLE, as
 * work-rls.test.ts does. The owner session seeds and cleans up with
 * app.rls_bypass on. No org or workspace rows are seeded: no work table has a
 * foreign key to either.
 *
 * CI: rls-integration job.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const APP_ROLE = "oxagen_app";

/** A fixed id in this suite's reserved blocks, 0077 to 0079. */
function id(block: string, n: number): string {
  return `00000000-0000-0000-${block}-${String(n).padStart(12, "0")}`;
}

const ORG_A = id("0077", 1);
const ORG_B = id("0077", 2);
const WS_A = id("0077", 3);
const WS_A_OTHER = id("0077", 4);
const WS_B = id("0077", 5);
const ITEM_A = id("0078", 1);
const ITEM_A_TWO = id("0078", 2);
const ITEM_A_OTHER_WS = id("0078", 3);
const ITEM_B = id("0078", 4);
const BRIEF_A = id("0078", 5);
const BRIEF_B = id("0078", 6);
const ORDER_A = id("0078", 7);
const ORDER_B = id("0078", 8);
const DIRECT_A = id("0079", 1);
const DIRECT_A_TWO = id("0079", 2);
const DIRECT_B = id("0079", 3);
const CHECK_A = id("0079", 4);
const CHECK_B = id("0079", 5);
const RUN_TOTALS_RUN = "tse_f13proofrunwithorder";

const DIGEST = `sha256:${"7".repeat(64)}`;

type Scope = { org: string; workspace: string; orgWide?: "on" | "off" };
const TENANT_A: Scope = { org: ORG_A, workspace: WS_A };
const TENANT_A_OTHER_WS: Scope = { org: ORG_A, workspace: WS_A_OTHER };
const TENANT_B: Scope = { org: ORG_B, workspace: WS_B };
const ORG_WIDE_A: Scope = { org: ORG_A, workspace: "", orgWide: "on" };
const NO_SCOPE: Scope = { org: "", workspace: "" };

/** Run fn as oxagen_app with the tenant GUCs set for this transaction only. */
async function asApp<T>(scope: Scope, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${scope.org},              true),
        set_config('app.current_workspace_id', ${scope.workspace},        true),
        set_config('app.org_wide',             ${scope.orgWide ?? "off"}, true),
        set_config('app.rls_bypass',           'off',                     true)
    `;
    return fn(tx);
  }) as Promise<T>;
}

/** Run fn as the owner role with RLS bypassed. */
async function asOwner<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    return fn(tx);
  }) as Promise<T>;
}

async function cleanup(): Promise<void> {
  await asOwner(async (tx) => {
    for (const org of [ORG_A, ORG_B]) {
      await tx`DELETE FROM cost.run_totals WHERE org_id = ${org}`;
      await tx`DELETE FROM work.done_checks WHERE org_id = ${org}`;
      await tx`DELETE FROM work.direct_orders WHERE org_id = ${org}`;
      await tx`DELETE FROM work.orders WHERE org_id = ${org}`;
      await tx`DELETE FROM work.briefs WHERE org_id = ${org}`;
      await tx`DELETE FROM work.items WHERE org_id = ${org}`;
    }
  });
}

/** Seed one tenant's item, brief, send, direct work order, and check run. */
async function seed(
  tx: postgres.TransactionSql,
  t: { key: string; org: string; workspace: string; item: string; brief: string; order: string; direct: string; check: string },
): Promise<void> {
  await tx`
    INSERT INTO work.items (id, public_id, org_id, workspace_id, number, subject, origin)
    VALUES (${t.item}, ${`wi_f13proof${t.key}`}, ${t.org}, ${t.workspace}, ${`F13-${t.key}`}, 'Fix invites', 'manual')
  `;
  await tx`
    INSERT INTO work.briefs (id, public_id, org_id, workspace_id, item_id, revision, item_revision, body, digest, author)
    VALUES (${t.brief}, ${`brf_f13proof${t.key}`}, ${t.org}, ${t.workspace}, ${t.item}, 1, 1, '{}'::jsonb, ${DIGEST}, 'f13-proof')
  `;
  await tx`
    INSERT INTO work.orders
      (id, public_id, org_id, workspace_id, item_id, item_revision, send, brief_id, brief_revision, brief_digest,
       idempotency_key, agent_id, runtime_id, runtime_tier, operator_id, repository)
    VALUES
      (${t.order}, ${`wo_f13proof${t.key}`}, ${t.org}, ${t.workspace}, ${t.item}, 1, 1, ${t.brief}, 1, ${DIGEST},
       ${`f13-proof-${t.key}:r1:s1`}, ${t.org}, ${t.workspace}, 'gateway', ${t.org}, 'aintel/platform')
  `;
  await tx`
    INSERT INTO work.direct_orders (id, public_id, org_id, workspace_id, run_id, opened_at)
    VALUES (${t.direct}, ${`dwo_f13proof${t.key}`}, ${t.org}, ${t.workspace}, ${`tse_f13proof${t.key}`}, now() - interval '1 hour')
  `;
  await tx`
    INSERT INTO work.done_checks
      (id, org_id, workspace_id, order_id, record_digest, verdict, result, checked_at, session_id, role)
    VALUES (${t.check}, ${t.org}, ${t.workspace}, ${t.order}, ${DIGEST}, 'pending', 'pending', now(), ${`session-${t.key}`}, 'Fix')
  `;
}

beforeAll(async () => {
  const [role] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!role?.exists) throw new Error("the work order capture proof requires the migrated oxagen_app role");
  await cleanup();
  await asOwner(async (tx) => {
    await seed(tx, { key: "a", org: ORG_A, workspace: WS_A, item: ITEM_A, brief: BRIEF_A, order: ORDER_A, direct: DIRECT_A, check: CHECK_A });
    await seed(tx, { key: "b", org: ORG_B, workspace: WS_B, item: ITEM_B, brief: BRIEF_B, order: ORDER_B, direct: DIRECT_B, check: CHECK_B });
    await tx`
      INSERT INTO work.items (id, public_id, org_id, workspace_id, number, subject, origin)
      VALUES
        (${ITEM_A_TWO}, 'wi_f13proofa2', ${ORG_A}, ${WS_A}, 'F13-a-2', 'Fix exports', 'manual'),
        (${ITEM_A_OTHER_WS}, 'wi_f13proofa3', ${ORG_A}, ${WS_A_OTHER}, 'F13-a-3', 'Fix imports', 'manual')
    `;
    await tx`
      INSERT INTO work.direct_orders (id, public_id, org_id, workspace_id, run_id, opened_at)
      VALUES (${DIRECT_A_TWO}, 'dwo_f13proofa2', ${ORG_A}, ${WS_A}, 'tse_f13proofa2', now() - interval '2 hours')
    `;
  });
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
});

/** The seeded ids a scope can read from one table, sorted. */
async function visible(scope: Scope, table: "work.direct_orders" | "work.done_checks"): Promise<string[]> {
  const ids = [DIRECT_A, DIRECT_A_TWO, DIRECT_B, CHECK_A, CHECK_B];
  const rows = await asApp(scope, (tx) =>
    tx<{ id: string }[]>`SELECT id::text AS id FROM ${tx(table)} WHERE id IN ${tx(ids)}`,
  );
  return rows.map((r) => r.id).sort();
}

describe("tenant isolation", () => {
  it("shows each tenant only its own direct work orders", async () => {
    expect(await visible(TENANT_A, "work.direct_orders")).toEqual([DIRECT_A, DIRECT_A_TWO].sort());
    expect(await visible(ORG_WIDE_A, "work.direct_orders")).toEqual([DIRECT_A, DIRECT_A_TWO].sort());
    expect(await visible(TENANT_A_OTHER_WS, "work.direct_orders")).toEqual([]);
    expect(await visible(TENANT_B, "work.direct_orders")).toEqual([DIRECT_B]);
    expect(await visible(NO_SCOPE, "work.direct_orders")).toEqual([]);
  });

  it("shows each tenant only its own check runs", async () => {
    expect(await visible(TENANT_A, "work.done_checks")).toEqual([CHECK_A]);
    expect(await visible(ORG_WIDE_A, "work.done_checks")).toEqual([CHECK_A]);
    expect(await visible(TENANT_A_OTHER_WS, "work.done_checks")).toEqual([]);
    expect(await visible(TENANT_B, "work.done_checks")).toEqual([CHECK_B]);
    expect(await visible(NO_SCOPE, "work.done_checks")).toEqual([]);
  });

  it("refuses a direct work order or a check run that org B stamps with org A", async () => {
    await expect(
      asApp(TENANT_B, (tx) => tx`
        INSERT INTO work.direct_orders (public_id, org_id, workspace_id, run_id, opened_at)
        VALUES ('dwo_f13proofforged', ${ORG_A}, ${WS_A}, 'tse_f13proofforged', now())
      `),
    ).rejects.toThrow(/row-level security/i);
    await expect(
      asApp(TENANT_B, (tx) => tx`
        INSERT INTO work.done_checks (org_id, workspace_id, order_id, record_digest, verdict, result, checked_at, session_id, role)
        VALUES (${ORG_A}, ${WS_A}, ${ORDER_A}, ${DIGEST}, 'held', 'passed', now(), 'session-forged', 'Fix')
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("matches no org A direct work order when org B attaches it", async () => {
    const attached = await asApp(TENANT_B, (tx) => tx`
      UPDATE work.direct_orders SET item_id = ${ITEM_B}, attached_at = now(), attached_by = 'f13-proof'
      WHERE id = ${DIRECT_A} RETURNING id
    `);
    expect(attached).toHaveLength(0);
  });
});

describe("direct work orders", () => {
  it("records the work item and the time it was attached, once", async () => {
    const [row] = await asApp(TENANT_A, (tx) => tx<{ item_id: string; attached_at: Date; opened_at: Date }[]>`
      UPDATE work.direct_orders SET item_id = ${ITEM_A}, attached_at = clock_timestamp(), attached_by = 'f13-proof'
      WHERE id = ${DIRECT_A} RETURNING item_id::text, attached_at, opened_at
    `);
    expect(row?.item_id).toBe(ITEM_A);
    expect(row!.attached_at.getTime()).toBeGreaterThan(row!.opened_at.getTime());

    // An attachment cannot move to another work item, or be cleared.
    await expect(
      asApp(TENANT_A, (tx) => tx`UPDATE work.direct_orders SET item_id = ${ITEM_A_TWO} WHERE id = ${DIRECT_A}`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asApp(TENANT_A, (tx) => tx`
        UPDATE work.direct_orders SET item_id = NULL, attached_at = NULL, attached_by = NULL WHERE id = ${DIRECT_A}
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a work item from another workspace, even one in its own org", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`
        UPDATE work.direct_orders SET item_id = ${ITEM_A_OTHER_WS}, attached_at = now(), attached_by = 'f13-proof'
        WHERE id = ${DIRECT_A_TWO}
      `),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("moves the work item, the time, and the attacher together", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`UPDATE work.direct_orders SET item_id = ${ITEM_A_TWO} WHERE id = ${DIRECT_A_TWO}`),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "direct_orders_attached_check" });
  });

  it("never changes the run it covers", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`UPDATE work.direct_orders SET run_id = 'tse_f13proofmoved' WHERE id = ${DIRECT_A_TWO}`),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      asApp(TENANT_A, (tx) => tx`UPDATE work.direct_orders SET opened_at = now() WHERE id = ${DIRECT_A_TWO}`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("holds one direct work order per run", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`
        INSERT INTO work.direct_orders (public_id, org_id, workspace_id, run_id, opened_at)
        VALUES ('dwo_f13proofdup', ${ORG_A}, ${WS_A}, 'tse_f13proofa', now())
      `),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "direct_orders_run_uniq" });
  });

  it("gives oxagen_app no DELETE", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`DELETE FROM work.direct_orders WHERE id = ${DIRECT_A_TWO}`),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("check runs", () => {
  it("refuses an UPDATE or a DELETE from oxagen_app", async () => {
    await expect(
      asApp(TENANT_A, (tx) => tx`UPDATE work.done_checks SET verdict = 'held', result = 'passed' WHERE id = ${CHECK_A}`),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      asApp(TENANT_A, (tx) => tx`DELETE FROM work.done_checks WHERE id = ${CHECK_A}`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("refuses an UPDATE from any role", async () => {
    await expect(
      asOwner((tx) => tx`UPDATE work.done_checks SET role = 'Verify' WHERE id = ${CHECK_A}`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("records a result that follows the verdict, and one check per stage session", async () => {
    await asApp(TENANT_A, (tx) => tx`
      INSERT INTO work.done_checks (org_id, workspace_id, order_id, record_digest, verdict, result, checked_at, session_id, role)
      VALUES (${ORG_A}, ${WS_A}, ${ORDER_A}, ${DIGEST}, 'held', 'passed', now(), 'session-a-2', 'Verify')
    `);
    await expect(
      asApp(TENANT_A, (tx) => tx`
        INSERT INTO work.done_checks (org_id, workspace_id, order_id, record_digest, verdict, result, checked_at, session_id, role)
        VALUES (${ORG_A}, ${WS_A}, ${ORDER_A}, ${DIGEST}, 'broken', 'passed', now(), 'session-a-3', 'Verify')
      `),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "done_checks_result_check" });
    await expect(
      asApp(TENANT_A, (tx) => tx`
        INSERT INTO work.done_checks (org_id, workspace_id, order_id, record_digest, verdict, result, checked_at, session_id, role)
        VALUES (${ORG_A}, ${WS_A}, ${ORDER_A}, ${DIGEST}, 'broken', 'failed', now(), 'session-a', 'Verify')
      `),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "done_checks_session_uniq" });
  });
});

describe("run_totals work order", () => {
  async function insertTotals(workOrderId: string | null, kind: string | null) {
    return asOwner((tx) => tx`
      INSERT INTO cost.run_totals
        (org_id, workspace_id, run_id, run_source, started_at, steps, model_calls, tool_calls, tokens, breakdown,
         rolled_up_at, work_order_id, work_order_kind)
      VALUES
        (${ORG_A}, ${WS_A}, ${RUN_TOTALS_RUN}, 'tacho', now(), 0, 0, 0, '{}'::jsonb, '{"models":[],"tools":[]}'::jsonb,
         now(), ${workOrderId}, ${kind})
    `);
  }

  it("names the work order and its kind together", async () => {
    await expect(insertTotals(ORDER_A, null)).rejects.toMatchObject({
      code: "23514",
      constraint_name: "run_totals_work_order_pair_check",
    });
    await expect(insertTotals(ORDER_A, "loose")).rejects.toMatchObject({
      code: "23514",
      constraint_name: "run_totals_work_order_kind_check",
    });
    await insertTotals(DIRECT_A_TWO, "direct");
    const [row] = await asApp(TENANT_A, (tx) => tx<{ work_order_id: string; work_order_kind: string }[]>`
      SELECT work_order_id::text, work_order_kind FROM cost.run_totals WHERE run_id = ${RUN_TOTALS_RUN}
    `);
    expect(row).toEqual({ work_order_id: DIRECT_A_TWO, work_order_kind: "direct" });
  });
});
