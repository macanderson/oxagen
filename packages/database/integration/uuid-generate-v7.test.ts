/**
 * `20261003233000_uuid_generate_v7_native_on_pg18.sql`: the id default's
 * function after the move to Postgres 18 (#5395, ADR-295).
 *
 * Every table's id default calls `public.uuid_generate_v7()`. CI runs
 * Postgres 16, the version Aurora runs, so this proves the half CI can reach:
 * the migration applies on Postgres 16 without resolving `uuidv7()`, and the
 * function it leaves returns a uuid there. On Postgres 18 the same body
 * returns `uuidv7()`, and the version check below expects a v7 id when the
 * server is 18 or later, so the case holds on either.
 *
 * The migration is read out of its file rather than restated here, so a
 * change to the file is what this tests.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration integration/uuid-generate-v7.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const MIGRATION = new URL(
  "../atlas/migrations/20261003233000_uuid_generate_v7_native_on_pg18.sql",
  import.meta.url,
);

/** RFC 9562 text form: the version is the first digit of the third group. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

interface FunctionShape {
  language: string;
  volatility: string;
  result: string;
  fromExtension: boolean;
}

async function shape(): Promise<FunctionShape | null> {
  const rows = await sql<FunctionShape[]>`
    SELECT l.lanname AS language,
           p.provolatile AS volatility,
           pg_get_function_result(p.oid) AS result,
           EXISTS (
             SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_proc'::regclass
               AND d.objid = p.oid
               AND d.deptype = 'e'
           ) AS "fromExtension"
    FROM pg_proc p
    JOIN pg_language l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure('public.uuid_generate_v7()')
  `;
  return rows[0] ?? null;
}

/** The version digit `uuid_generate_v7()` should give on this server. */
async function expectedVersion(fromExtension: boolean): Promise<string> {
  const [row] = await sql<{ version: number }[]>`
    SELECT current_setting('server_version_num')::int AS version
  `;
  // The pg_uuidv7 extension's own function returns v7 on any version.
  if (fromExtension || (row?.version ?? 0) >= 180000) return "7";
  return "4";
}

async function generate(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    SELECT public.uuid_generate_v7()::text AS id
  `;
  return row?.id ?? "";
}

afterAll(async () => {
  await sql.end({ timeout: 5 });
});

describe("20261003233000_uuid_generate_v7_native_on_pg18", () => {
  it("leaves a volatile PL/pgSQL function that returns uuid", async () => {
    const found = await shape();
    expect(found, "public.uuid_generate_v7() must exist").not.toBeNull();
    expect(found?.result).toBe("uuid");
    // Volatile, or every row in one statement would share an id.
    expect(found?.volatility).toBe("v");
    // A dev database with pg_uuidv7 keeps the extension's function. CI's
    // postgres:16-alpine has no pg_uuidv7, so CI checks the replacement.
    if (!found?.fromExtension) expect(found?.language).toBe("plpgsql");
  });

  it("returns a uuid of the version this server supports", async () => {
    const found = await shape();
    const want = await expectedVersion(found?.fromExtension ?? false);
    const id = await generate();
    expect(id).toMatch(UUID);
    expect(id.charAt(14)).toBe(want);
  });

  it("returns a new id on every call", async () => {
    const ids = await sql<{ id: string }[]>`
      SELECT public.uuid_generate_v7()::text AS id FROM generate_series(1, 50)
    `;
    expect(new Set(ids.map((r) => r.id)).size).toBe(50);
  });

  it("applies a second time and changes nothing", async () => {
    const before = await shape();
    await sql.unsafe(readFileSync(MIGRATION, "utf8"));
    expect(await shape()).toEqual(before);
    expect(await generate()).toMatch(UUID);
  });
});
