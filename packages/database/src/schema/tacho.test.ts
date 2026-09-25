/**
 * The tacho.sessions CHECK constraints are generated from the `TACHO_*`
 * lists in `./tacho.ts`, and a value added to a list without the paired Atlas
 * migration fails silently at review and loudly at ingest: Drizzle's types
 * admit the value, the insert compiles, and the database rejects the row.
 *
 * The migration is discovered, not hard-coded: whoever widens a list writes a
 * new migration that drops and re-adds the whole constraint, and this guard
 * moves to it on its own.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  TACHO_ENFORCEMENT_TIERS,
  TACHO_RUNTIMES,
  TACHO_SESSION_OUTCOMES,
  tachoSessions,
} from "./tacho";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../atlas/migrations/", import.meta.url),
);

/** The most recent migration that (re)defines the named CHECK constraint. */
function latestMigrationDefining(constraint: string): {
  file: string;
  sql: string;
} {
  const candidates = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of candidates) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (sql.includes(`"${constraint}"`)) return { file, sql };
  }
  throw new Error(`No migration defines ${constraint}`);
}

/** The quoted value list inside the constraint's `IN (...)`, in order. */
function checkedValues(sql: string, constraint: string): string[] {
  const escaped = constraint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `"${escaped}"\\s+CHECK\\s*\\([^)]*?IN\\s*\\(([^)]*)\\)`,
  ).exec(sql);
  if (!match?.[1]) throw new Error(`${constraint} has no IN (...) list`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("tacho.sessions CHECK constraints match the schema lists", () => {
  const cases: Array<{ constraint: string; values: readonly string[] }> = [
    { constraint: "tacho_sessions_runtime_check", values: TACHO_RUNTIMES },
    {
      constraint: "tacho_sessions_outcome_check",
      values: TACHO_SESSION_OUTCOMES,
    },
    {
      constraint: "tacho_sessions_tier_check",
      values: TACHO_ENFORCEMENT_TIERS,
    },
  ];

  for (const { constraint, values } of cases) {
    it(`the latest migration defining ${constraint} checks exactly the schema list`, () => {
      const { file, sql } = latestMigrationDefining(constraint);
      expect(
        checkedValues(sql, constraint),
        `${file} drifted from tacho.ts`,
      ).toEqual([...values]);
    });
  }

  it("the runtime constraint admits codex, so a Codex session is not filed as custom", () => {
    const { sql } = latestMigrationDefining("tacho_sessions_runtime_check");
    expect(TACHO_RUNTIMES).toContain("codex");
    expect(checkedValues(sql, "tacho_sessions_runtime_check")).toContain(
      "codex",
    );
  });

  it("the runtime constraint admits cursor, so a Cursor session is not filed as custom", () => {
    const { sql } = latestMigrationDefining("tacho_sessions_runtime_check");
    expect(TACHO_RUNTIMES).toContain("cursor");
    expect(checkedValues(sql, "tacho_sessions_runtime_check")).toContain(
      "cursor",
    );
  });
});

describe("tacho.sessions holds no readable email address (#3072)", () => {
  /** Every migration, oldest first, with its text. */
  function migrations(): Array<{ file: string; sql: string }> {
    return readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((file) => ({
        file,
        sql: readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
      }));
  }

  it("a migration after the one that created anthropic_user_email drops it", () => {
    const all = migrations();
    const created = all.findIndex(({ sql }) =>
      /"anthropic_user_email"\s+text/.test(sql),
    );
    const dropped = all.findIndex(({ sql }) =>
      /^ALTER TABLE "tacho"\."sessions" DROP COLUMN IF EXISTS "anthropic_user_email";$/m.test(
        sql,
      ),
    );
    expect(created, "no migration creates the column").toBeGreaterThanOrEqual(
      0,
    );
    expect(dropped, "no migration drops the column").toBeGreaterThan(created);
  });

  it("the schema declares no column for the address", () => {
    const names = Object.values(getTableColumns(tachoSessions)).map(
      (column) => column.name,
    );
    expect(names).not.toContain("anthropic_user_email");
    expect(names.filter((name) => /email/.test(name))).toEqual([]);
  });
});
