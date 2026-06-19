// migrate.test.ts
//
// Unit tests for the pure `splitStatements` helper exported from migrate.ts.
//
// splitStatements splits a SQL string on semicolons (`;` at end of lines),
// strips leading `--` comment lines from each chunk, and filters out empty
// or comment-only statements.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

const here = dirname(fileURLToPath(import.meta.url));

describe("splitStatements", () => {
  it("empty input returns empty array", () => {
    expect(splitStatements("")).toEqual([]);
  });

  it("single statement without a trailing semicolon returns 1 element", () => {
    const result = splitStatements("SELECT 1");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("SELECT 1");
  });

  it("single statement with a trailing semicolon returns 1 element", () => {
    // The split is on /;\s*$/m — the semicolon itself is consumed.
    const result = splitStatements("SELECT 1;");
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("SELECT 1");
  });

  it("two statements split on semicolon", () => {
    const sql = "SELECT 1;\nSELECT 2;";
    const result = splitStatements(sql);
    expect(result).toHaveLength(2);
    expect(result[0]).toBe("SELECT 1");
    expect(result[1]).toBe("SELECT 2");
  });

  it("three statements split correctly", () => {
    const sql = "CREATE TABLE a (id INT);\nCREATE TABLE b (id INT);\nCREATE TABLE c (id INT);";
    const result = splitStatements(sql);
    expect(result).toHaveLength(3);
  });

  it("-- comment lines are stripped from each chunk", () => {
    const sql = "-- create foo\nCREATE TABLE foo (id INT);";
    const result = splitStatements(sql);
    expect(result).toHaveLength(1);
    expect(result[0]).not.toContain("-- create foo");
    expect(result[0]).toContain("CREATE TABLE foo");
  });

  it("comment-only chunks are filtered out (empty after stripping comments)", () => {
    // A chunk that is only comment lines becomes an empty string after strip → filtered
    const sql = "-- just a comment\n;\nSELECT 1;";
    const result = splitStatements(sql);
    // The "-- just a comment\n" chunk → stripped → empty → filtered
    expect(result).not.toContain("");
    // SELECT 1 must still be present
    expect(result.some((s) => s.includes("SELECT 1"))).toBe(true);
  });

  it("whitespace-only chunks are filtered out", () => {
    const sql = "SELECT 1;\n   \nSELECT 2;";
    const result = splitStatements(sql);
    // The whitespace-only middle chunk is filtered
    for (const s of result) {
      expect(s.trim().length).toBeGreaterThan(0);
    }
    expect(result).toHaveLength(2);
  });

  it("inline comments (not at line start) are preserved inside the statement body", () => {
    // Only *line-start* `--` lines are stripped. Inline `--` in a SQL expression
    // is not stripped by the current implementation.
    const sql = "SELECT 1 -- this is inline;";
    const result = splitStatements(sql);
    // The inline comment is part of the statement body; the chunk is non-empty
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it("multiple blank lines between statements do not produce extra empty elements", () => {
    const sql = "SELECT 1;\n\n\nSELECT 2;";
    const result = splitStatements(sql);
    // No empty strings in the output
    for (const s of result) {
      expect(s.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// skill_loads (OXA-1750) — assert the table is created by the migrate inputs.
//
// migrate() runs schema.sql then every migrations/*.sql on each run. We assert
// the skill_loads CREATE is present in BOTH the canonical schema.sql (desired
// state) and the versioned migration (existing-deployment path), and that
// splitStatements — the exact function migrate() uses — extracts an executable
// CREATE TABLE statement for it from each source.
// ---------------------------------------------------------------------------

describe("skill_loads migration inputs", () => {
  const schemaSql = readFileSync(join(here, "schema.sql"), "utf8");
  const migrationSql = readFileSync(
    join(here, "migrations", "0008_skill_loads.sql"),
    "utf8",
  );

  function skillLoadsCreate(sql: string): string | undefined {
    return splitStatements(sql).find(
      (s) => /CREATE TABLE IF NOT EXISTS skill_loads\b/i.test(s),
    );
  }

  it("schema.sql defines skill_loads as a CREATE TABLE statement", () => {
    const stmt = skillLoadsCreate(schemaSql);
    expect(stmt).toBeDefined();
    expect(stmt).toMatch(/CREATE TABLE IF NOT EXISTS skill_loads/i);
  });

  it("a versioned 0008 migration also creates skill_loads (existing-deployment path)", () => {
    const stmt = skillLoadsCreate(migrationSql);
    expect(stmt).toBeDefined();
    expect(stmt).toMatch(/CREATE TABLE IF NOT EXISTS skill_loads/i);
  });

  it("the skill_loads CREATE carries every required column", () => {
    const stmt = skillLoadsCreate(schemaSql) ?? "";
    for (const col of [
      "org_id String",
      "workspace_id String",
      "skill_id String",
      "skill_slug String",
      "skill_version UInt32",
      "execution_step_id Nullable(String)",
      "surface String",
      "load_latency_ms Nullable(UInt32)",
      "created_at DateTime",
    ]) {
      expect(stmt).toContain(col);
    }
  });

  it("skill_loads uses MergeTree partitioned by month, ordered for metrics reads", () => {
    const stmt = skillLoadsCreate(schemaSql) ?? "";
    expect(stmt).toMatch(/ENGINE = MergeTree\(\)/);
    expect(stmt).toMatch(/PARTITION BY toYYYYMM\(created_at\)/);
    expect(stmt).toMatch(
      /ORDER BY \(org_id, workspace_id, skill_id, created_at\)/,
    );
  });

  it("the migrations directory contains the 0008 skill_loads file", () => {
    const files = readdirSync(join(here, "migrations")).filter((f) =>
      f.endsWith(".sql"),
    );
    expect(files).toContain("0008_skill_loads.sql");
  });

  it("comment-only lines are stripped, leaving an executable statement", () => {
    // migrate() feeds raw file bytes (with -- comments) through splitStatements.
    const stmt = skillLoadsCreate(migrationSql) ?? "";
    expect(stmt).not.toMatch(/^\s*--/m);
    expect(stmt.startsWith("CREATE TABLE")).toBe(true);
  });
});
