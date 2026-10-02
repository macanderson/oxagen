/**
 * The Phase 1 work records hold their guarantees in the database, whoever
 * writes (P1-02, #4897; 20261002030300_work_records.sql).
 *
 * work-rls.test.ts proves tenant isolation on every work table. This suite
 * proves the rest against a live database, as the real `oxagen_app` role
 * with the tenant GUCs set:
 *
 *   - Source uniqueness: one provider item is one work item in a workspace,
 *     whichever collector heard it, and a soft-deleted item keeps its key.
 *   - Append only: oxagen_app cannot update or delete a brief, a fact, a
 *     triage decision, or a triage correction, and a trigger refuses an
 *     UPDATE of a brief or a fact even from the owner role.
 *   - A work order's send facts never change, its release and close move once,
 *     and one item and one agent each hold at most one open order.
 *   - Bindings: an order and a fact cannot name a brief digest or revision the
 *     brief does not have, a fact cannot name another item's order, and an
 *     item revision has at most one approved brief.
 *   - An item's identity never changes, and its revision never goes back.
 *   - An unknown triage model or cost stays null.
 *
 * The superuser session seeds and cleans up with app.rls_bypass on. Every
 * assertion that matters runs as oxagen_app via SET LOCAL ROLE, like
 * work-rls.test.ts.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const APP_ROLE = "oxagen_app";

/** A fixed id in this suite's reserved blocks, 0070 to 0076. */
function id(block: string, n: number): string {
  return `00000000-0000-0000-${block}-${String(n).padStart(12, "0")}`;
}

const ORG = id("0070", 1);
const WS = id("0070", 2);
const WS_OTHER = id("0070", 3);
const COLLECTOR_ONE = id("0071", 1);
const COLLECTOR_TWO = id("0071", 2);
const COLLECTOR_OTHER = id("0071", 3);
const ITEM = id("0072", 1);
const ITEM_TWO = id("0072", 2);
const BRIEF = id("0073", 1);
const BRIEF_TWO = id("0073", 2);
const ORDER = id("0074", 1);
const AGENT = id("0075", 1);
const AGENT_TWO = id("0075", 2);
const RUNTIME = id("0075", 3);
const OPERATOR = id("0075", 4);
const DECISION = id("0076", 1);

const DIGEST = `sha256:${"1".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"2".repeat(64)}`;
const PROVIDER_ID = "issue:node:I_kwDOrecords";

type Scope = { org: string; workspace: string };
const TENANT: Scope = { org: ORG, workspace: WS };
const TENANT_OTHER_WS: Scope = { org: ORG, workspace: WS_OTHER };

/** Run fn as oxagen_app with the tenant GUCs set for this transaction only. */
async function asApp<T>(scope: Scope, fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${scope.org},       true),
        set_config('app.current_workspace_id', ${scope.workspace}, true),
        set_config('app.org_wide',             'off',              true),
        set_config('app.rls_bypass',           'off',              true)
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
    for (const workspace of [WS, WS_OTHER]) {
      await tx`DELETE FROM work.item_facts WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.orders WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.briefs WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.triage_corrections WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.triage_decisions WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.items WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
      await tx`DELETE FROM work.collectors WHERE org_id = ${ORG} AND workspace_id = ${workspace}`;
    }
  });
}

/** Insert a work item as oxagen_app. */
function insertItem(tx: postgres.TransactionSql, row: { id: string; number: string; collector: string | null; providerId: string | null; workspace?: string }) {
  return tx`
    INSERT INTO work.items (id, public_id, org_id, workspace_id, number, subject, origin, collector_id, provider_id)
    VALUES (${row.id}, ${`wi_records${row.number.toLowerCase().replace(/[^0-9a-z]/g, "")}`}, ${ORG}, ${row.workspace ?? WS},
            ${row.number}, 'Fix invites', ${row.providerId === null ? "manual" : "provider"}, ${row.collector}, ${row.providerId})
  `;
}

/** Insert an order as oxagen_app. */
function insertOrder(
  tx: postgres.TransactionSql,
  row: { id: string; item: string; send: number; brief: string; digest?: string; revision?: number; agent: string; key: string },
) {
  return tx`
    INSERT INTO work.orders
      (id, public_id, org_id, workspace_id, item_id, item_revision, send, brief_id, brief_revision, brief_digest,
       idempotency_key, agent_id, runtime_id, runtime_tier, operator_id, repository)
    VALUES
      (${row.id}, ${`wo_rec${row.id.slice(-12)}`}, ${ORG}, ${WS}, ${row.item}, 1, ${row.send}, ${row.brief},
       ${row.revision ?? 1}, ${row.digest ?? DIGEST}, ${row.key}, ${row.agent}, ${RUNTIME}, 'gateway', ${OPERATOR}, 'aintel/platform')
  `;
}

/** Insert a fact as oxagen_app. */
function insertFact(
  tx: postgres.TransactionSql,
  row: { item: string; kind: string; key: string; order?: string | null; brief?: string | null; digest?: string | null; revision?: number },
) {
  return tx`
    INSERT INTO work.item_facts
      (org_id, workspace_id, item_id, order_id, kind, source, item_revision, brief_id, brief_digest, actor, occurred_at, dedupe_key)
    VALUES
      (${ORG}, ${WS}, ${row.item}, ${row.order ?? null}, ${row.kind}, 'person', ${row.revision ?? 1},
       ${row.brief ?? null}, ${row.digest ?? null}, 'records-proof', now(), ${row.key})
  `;
}

beforeAll(async () => {
  const [role] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!role?.exists) throw new Error("the work records proof requires the migrated oxagen_app role");
  await cleanup();
  await asOwner(async (tx) => {
    for (const [collector, workspace, name] of [
      [COLLECTOR_ONE, WS, "records-one"],
      [COLLECTOR_TWO, WS, "records-two"],
      [COLLECTOR_OTHER, WS_OTHER, "records-other"],
    ] as const) {
      await tx`
        INSERT INTO work.collectors (id, org_id, workspace_id, name, type, file_hash)
        VALUES (${collector}, ${ORG}, ${workspace}, ${name}, 'github', 'records-proof')
      `;
    }
  });
  await asApp(TENANT, async (tx) => {
    await insertItem(tx, { id: ITEM, number: "REC-1", collector: COLLECTOR_ONE, providerId: PROVIDER_ID });
    await insertItem(tx, { id: ITEM_TWO, number: "REC-2", collector: null, providerId: null });
    await tx`
      INSERT INTO work.briefs (id, public_id, org_id, workspace_id, item_id, revision, item_revision, body, digest, author)
      VALUES
        (${BRIEF}, 'brf_recordsone', ${ORG}, ${WS}, ${ITEM}, 1, 1, '{}'::jsonb, ${DIGEST}, 'records-proof'),
        (${BRIEF_TWO}, 'brf_recordstwo', ${ORG}, ${WS}, ${ITEM_TWO}, 1, 1, '{}'::jsonb, ${OTHER_DIGEST}, 'records-proof')
    `;
    await insertOrder(tx, { id: ORDER, item: ITEM, send: 1, brief: BRIEF, agent: AGENT, key: "wi_recordsrec1:r1:s1" });
    await insertFact(tx, { item: ITEM, kind: "brief_approved", key: "approve:1", brief: BRIEF, digest: DIGEST });
    await insertFact(tx, { item: ITEM, kind: "send_requested", key: "send:1", order: ORDER, brief: BRIEF, digest: DIGEST });
    await tx`
      INSERT INTO work.triage_decisions
        (id, public_id, org_id, workspace_id, item_id, output, prompt_digest, priorities_hash, input_digest, item_revision)
      VALUES (${DECISION}, 'tri_records', ${ORG}, ${WS}, ${ITEM}, '{}'::jsonb, ${DIGEST}, ${DIGEST}, ${DIGEST}, 1)
    `;
  });
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
});

describe("source uniqueness", () => {
  it("refuses a second work item for the same provider item from another collector", async () => {
    await expect(
      asApp(TENANT, (tx) => insertItem(tx, { id: id("0072", 9), number: "REC-9", collector: COLLECTOR_TWO, providerId: PROVIDER_ID })),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "items_source_uniq" });
  });

  it("keeps the key of a soft-deleted item", async () => {
    await asApp(TENANT, (tx) => tx`UPDATE work.items SET deleted_at = now() WHERE id = ${ITEM}`);
    await expect(
      asApp(TENANT, (tx) => insertItem(tx, { id: id("0072", 9), number: "REC-9", collector: COLLECTOR_TWO, providerId: PROVIDER_ID })),
    ).rejects.toMatchObject({ code: "23505" });
    await asApp(TENANT, (tx) => tx`UPDATE work.items SET deleted_at = NULL WHERE id = ${ITEM}`);
  });

  it("lets another workspace hold the same provider item, and many items with no provider id", async () => {
    await asApp(TENANT_OTHER_WS, (tx) =>
      insertItem(tx, { id: id("0072", 5), number: "REC-5", collector: COLLECTOR_OTHER, providerId: PROVIDER_ID, workspace: WS_OTHER }),
    );
    await asApp(TENANT, (tx) => insertItem(tx, { id: id("0072", 6), number: "REC-6", collector: null, providerId: null }));
    const rows = await asOwner((tx) => tx`SELECT count(*)::int AS n FROM work.items WHERE org_id = ${ORG} AND provider_id = ${PROVIDER_ID}`);
    expect(rows[0]?.n).toBe(2);
  });
});

describe("append-only records", () => {
  it.each([
    ["work.briefs", BRIEF],
    ["work.triage_decisions", DECISION],
  ])("refuses oxagen_app an UPDATE or DELETE of %s", async (table, rowId) => {
    await expect(asApp(TENANT, (tx) => tx`UPDATE ${tx(table)} SET created_at = now() WHERE id = ${rowId}`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asApp(TENANT, (tx) => tx`DELETE FROM ${tx(table)} WHERE id = ${rowId}`)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses oxagen_app an UPDATE or DELETE of a fact or a triage correction", async () => {
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.item_facts SET actor = 'forged' WHERE item_id = ${ITEM}`)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(asApp(TENANT, (tx) => tx`DELETE FROM work.item_facts WHERE item_id = ${ITEM}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.triage_corrections SET field = 'x'`)).rejects.toMatchObject({ code: "42501" });
  });

  it("refuses an UPDATE of a brief or a fact even from the owner role", async () => {
    await expect(asOwner((tx) => tx`UPDATE work.briefs SET author = 'forged' WHERE id = ${BRIEF}`)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(asOwner((tx) => tx`UPDATE work.item_facts SET actor = 'forged' WHERE item_id = ${ITEM}`)).rejects.toMatchObject({
      code: "23514",
    });
  });

  it("keeps an unknown triage model and cost null, never 0", async () => {
    const [row] = await asApp(TENANT, (tx) => tx<{ model: string | null; cost_usd: string | null }[]>`
      SELECT model, cost_usd FROM work.triage_decisions WHERE id = ${DECISION}
    `);
    expect(row).toEqual({ model: null, cost_usd: null });
  });
});

describe("work orders", () => {
  it("refuses a change to a send fact", async () => {
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.orders SET agent_id = ${AGENT_TWO} WHERE id = ${ORDER}`)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      asApp(TENANT, (tx) => tx`UPDATE work.orders SET brief_digest = ${OTHER_DIGEST} WHERE id = ${ORDER}`),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses oxagen_app a DELETE, and a close before a release", async () => {
    await expect(asApp(TENANT, (tx) => tx`DELETE FROM work.orders WHERE id = ${ORDER}`)).rejects.toMatchObject({ code: "42501" });
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.orders SET closed_at = now() WHERE id = ${ORDER}`)).rejects.toMatchObject({
      code: "23514",
      constraint_name: "orders_closed_released_check",
    });
  });

  it("holds one open order per item and one unreleased order per agent", async () => {
    await expect(
      asApp(TENANT, (tx) => insertOrder(tx, { id: id("0074", 2), item: ITEM, send: 2, brief: BRIEF, agent: AGENT_TWO, key: "wi_recordsrec1:r1:s2" })),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "orders_open_item_uniq" });
    await expect(
      asApp(TENANT, (tx) =>
        insertOrder(tx, { id: id("0074", 3), item: ITEM_TWO, send: 1, brief: BRIEF_TWO, digest: OTHER_DIGEST, agent: AGENT, key: "wi_recordsrec2:r1:s1" }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "orders_open_agent_uniq" });
  });

  it("refuses a second order with the same idempotency key", async () => {
    await expect(
      asApp(TENANT, (tx) =>
        insertOrder(tx, { id: id("0074", 4), item: ITEM_TWO, send: 1, brief: BRIEF_TWO, digest: OTHER_DIGEST, agent: AGENT_TWO, key: "wi_recordsrec1:r1:s1" }),
      ),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "orders_key_uniq" });
  });

  it("refuses an order that names a digest or revision its brief does not have", async () => {
    await expect(
      asApp(TENANT, (tx) =>
        insertOrder(tx, { id: id("0074", 5), item: ITEM_TWO, send: 1, brief: BRIEF_TWO, digest: DIGEST, agent: AGENT_TWO, key: "wi_recordsrec2:r1:s1" }),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint_name: "orders_brief_fk" });
    await expect(
      asApp(TENANT, (tx) =>
        insertOrder(tx, { id: id("0074", 6), item: ITEM_TWO, send: 1, brief: BRIEF_TWO, digest: OTHER_DIGEST, revision: 2, agent: AGENT_TWO, key: "wi_recordsrec2:r2:s1" }),
      ),
    ).rejects.toMatchObject({ code: "23503", constraint_name: "orders_brief_fk" });
  });

  it("releases and closes once, then frees the agent and the item", async () => {
    await asApp(TENANT, (tx) => tx`UPDATE work.orders SET released_at = now() WHERE id = ${ORDER}`);
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.orders SET released_at = now() WHERE id = ${ORDER}`)).rejects.toMatchObject({
      code: "23514",
    });
    await asApp(TENANT, (tx) =>
      insertOrder(tx, { id: id("0074", 7), item: ITEM_TWO, send: 1, brief: BRIEF_TWO, digest: OTHER_DIGEST, agent: AGENT, key: "wi_recordsrec2:r1:s1" }),
    );
    await asApp(TENANT, (tx) => tx`UPDATE work.orders SET closed_at = now() WHERE id = ${ORDER}`);
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.orders SET closed_at = NULL WHERE id = ${ORDER}`)).rejects.toMatchObject({
      code: "23514",
    });
  });
});

describe("fact bindings", () => {
  it("refuses a fact that names a digest its brief does not have", async () => {
    await expect(
      asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "brief_saved", key: "brief:bad", brief: BRIEF, digest: OTHER_DIGEST })),
    ).rejects.toMatchObject({ code: "23503", constraint_name: "item_facts_brief_fk" });
    await expect(
      asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "brief_saved", key: "brief:half", brief: BRIEF, digest: null })),
    ).rejects.toMatchObject({ code: "23514", constraint_name: "item_facts_brief_check" });
  });

  it("refuses a fact that names another item's order, and an order fact with no order", async () => {
    await expect(
      asApp(TENANT, (tx) => insertFact(tx, { item: ITEM_TWO, kind: "claimed", key: "claimed:wrong", order: ORDER })),
    ).rejects.toMatchObject({ code: "23503", constraint_name: "item_facts_order_fk" });
    await expect(asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "claimed", key: "claimed:none" }))).rejects.toMatchObject({
      code: "23514",
      constraint_name: "item_facts_order_check",
    });
  });

  it("holds one approved brief per item revision, and one fact per dedupe key", async () => {
    await expect(
      asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "brief_approved", key: "approve:again", brief: BRIEF, digest: DIGEST })),
    ).rejects.toMatchObject({ code: "23505", constraint_name: "item_facts_approval_uniq" });
    await expect(asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "closed", key: "approve:1" }))).rejects.toMatchObject({
      code: "23505",
      constraint_name: "item_facts_dedupe_uniq",
    });
  });

  it("refuses an unknown kind", async () => {
    await expect(asApp(TENANT, (tx) => insertFact(tx, { item: ITEM, kind: "proven", key: "proven" }))).rejects.toMatchObject({
      code: "23514",
      constraint_name: "item_facts_kind_check",
    });
  });
});

describe("work item identity and revision", () => {
  it("accepts the running and review states and refuses an unknown one", async () => {
    await asApp(TENANT, (tx) => tx`UPDATE work.items SET state = 'running' WHERE id = ${ITEM}`);
    await asApp(TENANT, (tx) => tx`UPDATE work.items SET state = 'review' WHERE id = ${ITEM}`);
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.items SET state = 'proven' WHERE id = ${ITEM}`)).rejects.toMatchObject({
      code: "23514",
      constraint_name: "items_state_check",
    });
  });

  it("moves the revision and version forward and never back", async () => {
    await asApp(TENANT, (tx) => tx`UPDATE work.items SET material_revision = 2, version = 3 WHERE id = ${ITEM}`);
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.items SET material_revision = 1 WHERE id = ${ITEM}`)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.items SET version = 2 WHERE id = ${ITEM}`)).rejects.toMatchObject({ code: "23514" });
  });

  it("refuses a change to an item's number, origin, or provider id", async () => {
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.items SET number = 'REC-99' WHERE id = ${ITEM}`)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(asApp(TENANT, (tx) => tx`UPDATE work.items SET origin = 'manual' WHERE id = ${ITEM}`)).rejects.toMatchObject({
      code: "23514",
    });
    await expect(
      asApp(TENANT, (tx) => tx`UPDATE work.items SET provider_id = 'issue:node:other' WHERE id = ${ITEM}`),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
