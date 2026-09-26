/**
 * The stored Model fit reading (#3893, ADR-194). `tacho.sessions` and
 * `agent.agent_runs` each carry the reading and its provenance in four
 * columns: the reading, the rule it was computed under, when it was read,
 * and the seal it read. A reading without its provenance cannot be cited,
 * so a CHECK sets the four together.
 *
 * The migration is discovered, not hard-coded, as `tacho.test.ts` does it:
 * the latest migration that defines each constraint must set all four
 * columns together, so the database refuses what Drizzle's types refuse.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { agentRuns } from "./agent";
import { tachoSessions } from "./tacho";

const MIGRATIONS_DIR = fileURLToPath(
  new URL("../../atlas/migrations/", import.meta.url),
);

const FIT_COLUMNS = [
  "fit_reading",
  "fit_method",
  "fit_read_at",
  "fit_sealed_at",
] as const;

const TABLES: ReadonlyArray<[string, PgTable, string]> = [
  ["tacho.sessions", tachoSessions, "tacho_sessions_fit_check"],
  ["agent.agent_runs", agentRuns, "agent_runs_fit_check"],
];

/** The text of the latest migration's definition of `constraint`, up to its statement's end. */
function latestDefinition(constraint: string): { file: string; sql: string } {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .reverse();
  for (const file of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    const at = text.indexOf(`"${constraint}"`);
    if (at === -1) continue;
    const end = text.indexOf(";", at);
    return { file, sql: text.slice(at, end === -1 ? undefined : end) };
  }
  throw new Error(`No migration defines ${constraint}`);
}

describe("the stored Model fit reading", () => {
  it.each(TABLES)(
    "%s carries the four fit columns, each nullable, under one CHECK",
    (_name, table, constraint) => {
      const config = getTableConfig(table);
      const columns = new Map(
        config.columns.map((column) => [column.name, column]),
      );
      for (const name of FIT_COLUMNS) {
        const column = columns.get(name);
        expect(column, name).toBeDefined();
        // A run with no reading yet, and every live run, holds none.
        expect(column?.notNull, name).toBe(false);
      }
      expect(config.checks.map((check) => check.name)).toContain(constraint);
    },
  );

  it.each(TABLES)(
    "%s: the latest migration defining the CHECK sets all four columns together",
    (_name, _table, constraint) => {
      const { file, sql } = latestDefinition(constraint);
      expect(sql, file).toMatch(/\bCHECK\b/);
      for (const name of FIT_COLUMNS)
        expect(sql, `${file} leaves ${name} out of ${constraint}`).toMatch(
          new RegExp(`"?\\b${name}\\b"?\\s+IS\\s+NULL`, "i"),
        );
    },
  );
});
