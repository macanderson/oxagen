/**
 * work.done_verdicts and work.autonomy_events only ever get new rows (#4735).
 *
 * 20260929000000_work_schema.sql grants `oxagen_app` SELECT and INSERT on both
 * tables, and revokes UPDATE, DELETE, and TRUNCATE. This suite proves the
 * application role cannot change or remove a row it can read, so a verdict or
 * an autonomy change stays as it was written.
 *
 * Each refusal runs where RLS would let the statement through: in the row's
 * own org and workspace, and again with app.rls_bypass on, which is how
 * withSystemDb runs. So "permission denied" can only come from the grant.
 * Two controls show the scope is right: the same scope reads the row, and it
 * inserts a new one. After each refusal, a superuser read shows the row
 * unchanged.
 *
 * Superuser and RLS: a superuser has every privilege, so every assertion runs
 * as the real `oxagen_app` role via SET LOCAL ROLE, like work-rls.test.ts. The
 * superuser session seeds, checks, and cleans up, with app.rls_bypass on.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration -- integration/work-append-only.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

/** The real application role. Non-superuser and no BYPASSRLS. */
const APP_ROLE = "oxagen_app";

/** A fixed id in this suite's reserved block. Blocks 007a to 007d are unused elsewhere in integration/. */
function id(block: string, n: number): string {
  return `00000000-0000-0000-${block}-${String(n).padStart(12, "0")}`;
}

const ORG = id("007a", 1);
const WORKSPACE = id("007b", 1);
const DIGEST = `sha256:${"0".repeat(64)}`;

type AppendOnlyTable = {
  table: "work.done_verdicts" | "work.autonomy_events";
  /** The row the superuser seeds. */
  seeded: string;
  /** The row the insert control adds as oxagen_app. */
  added: string;
  /** The column each update tries to change, its seeded value as text, and the new value. */
  column: string;
  seededValue: string;
  newValue: string | number;
  insert: (tx: postgres.TransactionSql, rowId: string) => Promise<unknown>;
};

const TABLES: readonly AppendOnlyTable[] = [
  {
    table: "work.done_verdicts",
    seeded: id("007c", 1),
    added: id("007c", 2),
    column: "verdict",
    seededValue: "pending",
    newValue: "broken",
    insert: (tx, rowId) => tx`
      INSERT INTO work.done_verdicts (id, org_id, workspace_id, record_digest, verdict)
      VALUES (${rowId}, ${ORG}, ${WORKSPACE}, ${DIGEST}, 'pending')
    `,
  },
  {
    table: "work.autonomy_events",
    seeded: id("007d", 1),
    added: id("007d", 2),
    column: "to_level",
    seededValue: "0",
    newValue: 3,
    insert: (tx, rowId) => tx`
      INSERT INTO work.autonomy_events (id, org_id, workspace_id, scope, to_level, cause, "by")
      VALUES (${rowId}, ${ORG}, ${WORKSPACE}, '{}'::jsonb, 0, 'steering_pr', 'append-only-proof')
    `,
  },
];

/** Delete this suite's rows as the superuser. Safe to run on an empty database. */
async function cleanup(): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    for (const t of TABLES) {
      await tx`DELETE FROM ${tx(t.table)} WHERE id IN ${tx([t.seeded, t.added])}`;
    }
  });
}

/** A column's value as text, read as the superuser, or null when the row is gone. */
async function storedValue(t: AppendOnlyTable, rowId: string): Promise<string | null> {
  let value: string | null = null;
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    const rows = await tx<{ value: string }[]>`
      SELECT ${tx(t.column)}::text AS value FROM ${tx(t.table)} WHERE id = ${rowId}
    `;
    value = rows[0]?.value ?? null;
  });
  return value;
}

beforeAll(async () => {
  // Require the migrated role. A role this suite granted for itself would
  // prove only its own grants.
  const [role] = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = ${APP_ROLE}) AS exists
  `;
  if (!role?.exists) {
    throw new Error("work append-only proof requires the migrated oxagen_app role");
  }

  // A run that died before afterAll leaves its rows. Clear them so the seed
  // does not hit a duplicate key.
  await cleanup();
  await sql.begin(async (tx) => {
    await tx`SELECT set_config('app.rls_bypass', 'on', true)`;
    for (const t of TABLES) await t.insert(tx, t.seeded);
  });
});

afterAll(async () => {
  await cleanup();
  await sql.end({ timeout: 5 });
});

type Scope = { name: string; bypass: "on" | "off" };

/** The row's own org and workspace, with RLS enforced and with it bypassed. */
const SCOPES: readonly Scope[] = [
  { name: "the row's own workspace", bypass: "off" },
  { name: "the RLS bypass", bypass: "on" },
];

/** Run fn as oxagen_app in the row's org and workspace, for this transaction only. */
async function asApp(scope: Scope, fn: (tx: postgres.TransactionSql) => Promise<unknown>): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE "${APP_ROLE}"`);
    await tx`
      SELECT
        set_config('app.current_org_id',       ${ORG},          true),
        set_config('app.current_workspace_id', ${WORKSPACE},    true),
        set_config('app.org_wide',             'off',           true),
        set_config('app.rls_bypass',           ${scope.bypass}, true)
    `;
    await fn(tx);
  });
}

describe.each(TABLES)("$table is append only", (t) => {
  it("lets oxagen_app read the seeded row", async () => {
    for (const scope of SCOPES) {
      let ids: string[] = [];
      await asApp(scope, async (tx) => {
        const rows = await tx<{ id: string }[]>`
          SELECT id::text AS id FROM ${tx(t.table)} WHERE id = ${t.seeded}
        `;
        ids = rows.map((r) => r.id);
      });
      expect(ids, scope.name).toEqual([t.seeded]);
    }
  });

  it("lets oxagen_app insert a new row", async () => {
    await asApp(SCOPES[0]!, (tx) => t.insert(tx, t.added));
    expect(await storedValue(t, t.added)).toBe(t.seededValue);
  });

  describe.each(SCOPES)("under $name", (scope) => {
    it("refuses UPDATE with permission denied", async () => {
      await expect(
        asApp(scope, (tx) => tx`
          UPDATE ${tx(t.table)} SET ${tx(t.column)} = ${t.newValue} WHERE id = ${t.seeded}
        `),
      ).rejects.toThrow(/permission denied/i);
      expect(await storedValue(t, t.seeded)).toBe(t.seededValue);
    });

    it("refuses DELETE with permission denied", async () => {
      await expect(
        asApp(scope, (tx) => tx`DELETE FROM ${tx(t.table)} WHERE id = ${t.seeded}`),
      ).rejects.toThrow(/permission denied/i);
      expect(await storedValue(t, t.seeded)).toBe(t.seededValue);
    });

    it("refuses TRUNCATE with permission denied", async () => {
      // TRUNCATE skips RLS entirely, so the grant is the only thing in its way.
      await expect(
        asApp(scope, (tx) => tx`TRUNCATE ${tx(t.table)}`),
      ).rejects.toThrow(/permission denied/i);
      expect(await storedValue(t, t.seeded)).toBe(t.seededValue);
    });
  });
});
