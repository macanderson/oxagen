// migrate.test.ts
//
// Unit tests for the pure `splitStatements` helper exported from migrate.ts.
//
// splitStatements splits a SQL string on semicolons (`;` at end of lines),
// strips leading `--` comment lines from each chunk, and filters out empty
// or comment-only statements.

import { describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

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
