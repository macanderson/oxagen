/**
 * `20260612052000_regrant_oxagen_app.sql` — the guarded RLS-invariant block.
 *
 * The migration only runs `ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS
 * NOCREATEDB NOCREATEROLE` when the role's attributes actually need it.
 * PostgreSQL gates ALTER ROLE's SUPERUSER/BYPASSRLS clauses on the *actor's*
 * own superuser bit whether or not the value changes, and RDS/Aurora never
 * grants one (only rds_superuser) — an unconditional statement fails 42501 on
 * every Aurora target. Guarding it on the role's actual attributes makes it a
 * true no-op wherever the role is already safe.
 *
 * A guard that skips the repair it was written for is the failure mode worth
 * testing, so this drifts the role and asserts the block still repairs it. The
 * block is read out of the migration file rather than restated here: a copy
 * would keep passing after the migration changed.
 *
 * CI: rls-integration job. Local:
 *   DATABASE_URL=postgres://oxagen:oxagen@localhost:5433/oxagen \
 *     pnpm --filter @oxagen/database test:integration -- integration/regrant-oxagen-app.test.ts
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";

const sql = postgres(process.env["DATABASE_URL"]!, { max: 1, prepare: false });

const MIGRATION = new URL(
  "../atlas/migrations/20260612052000_regrant_oxagen_app.sql",
  import.meta.url,
);

interface RoleAttributes {
  rolsuper: boolean;
  rolbypassrls: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
}

/**
 * The `DO $$ ... $$;` block holding the guarded ALTER ROLE, lifted verbatim.
 *
 * Split on the block terminator rather than matched with one regex: the file's
 * first block also names `oxagen_app`, and a non-greedy match would span both
 * and produce SQL that does not parse.
 */
function guardedInvariantBlock(): string {
  const source = readFileSync(MIGRATION, "utf8");
  const chunk = source
    .split("$$;")
    .map((part) => `${part}$$;`)
    .find((part) => part.includes("ALTER ROLE oxagen_app"));
  if (!chunk) {
    throw new Error(
      "20260612052000_regrant_oxagen_app.sql no longer contains an ALTER ROLE oxagen_app block",
    );
  }
  const start = chunk.indexOf("DO $$");
  if (start < 0) {
    throw new Error(
      "the ALTER ROLE oxagen_app statement is no longer inside a DO block",
    );
  }
  return chunk.slice(start);
}

async function attributesOf(role: string): Promise<RoleAttributes | null> {
  const rows = await sql<RoleAttributes[]>`
    SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
    FROM pg_roles WHERE rolname = ${role}
  `;
  return rows[0] ?? null;
}

/** The safe state, restored after every case so nothing leaks between files. */
async function resetRole(): Promise<void> {
  await sql
    .unsafe(
      `ALTER ROLE oxagen_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE`,
    )
    .catch(() => undefined);
}

beforeAll(async () => {
  // The migration creates it; a database that skipped the directory would make
  // every case below vacuous rather than red.
  const rows = await sql<{ exists: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') AS exists
  `;
  expect(
    rows[0]?.exists,
    "oxagen_app must exist — did the migration run?",
  ).toBe(true);
});

afterAll(async () => {
  await resetRole();
  await sql.end({ timeout: 5 });
});

describe("20260612052000_regrant_oxagen_app: RLS safety invariants", () => {
  it("repairs a role that drifted to elevated privileges", async () => {
    await sql.unsafe(`ALTER ROLE oxagen_app BYPASSRLS CREATEDB CREATEROLE`);
    try {
      const drifted = await attributesOf("oxagen_app");
      expect(drifted?.rolbypassrls).toBe(true);

      await sql.unsafe(guardedInvariantBlock());

      const repaired = await attributesOf("oxagen_app");
      expect(repaired?.rolsuper).toBe(false);
      expect(repaired?.rolbypassrls).toBe(false);
      expect(repaired?.rolcreatedb).toBe(false);
      expect(repaired?.rolcreaterole).toBe(false);
    } finally {
      await resetRole();
    }
  });

  it("does not reach ALTER ROLE when the role is already safe", async () => {
    // This is the Aurora case. The connecting role there cannot execute ALTER
    // ROLE's BYPASSRLS clause at all, so the guard's predicate being false is
    // what keeps the migration applying — the statement is never reached.
    await resetRole();
    const before = await attributesOf("oxagen_app");
    expect(
      before?.rolsuper ||
        before?.rolbypassrls ||
        before?.rolcreatedb ||
        before?.rolcreaterole,
      "guard predicate must be false for an undrifted role",
    ).toBe(false);

    await expect(sql.unsafe(guardedInvariantBlock())).resolves.toBeDefined();

    const after = await attributesOf("oxagen_app");
    expect(after).toEqual(before);
  });

  it("leaves the migrated role with none of the four attributes", async () => {
    // The end state the migration exists to guarantee, read off the live
    // catalog: a role holding BYPASSRLS would make every tenant_isolation
    // policy in the database advisory.
    await resetRole();
    expect(await attributesOf("oxagen_app")).toMatchObject({
      rolsuper: false,
      rolbypassrls: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
  });
});
