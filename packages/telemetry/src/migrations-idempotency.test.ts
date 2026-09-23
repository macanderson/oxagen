// migrations-idempotency.test.ts
//
// The ledger repair in migrate.ts (#3698) replays a recorded migration file
// when a table it names is missing from the database. Replay is safe only
// when every statement in the file can run against a store that already
// carries part of it: a `CREATE TABLE` without `IF NOT EXISTS` fails the
// replay on the second table the file creates, and an `ADD COLUMN` without
// `IF NOT EXISTS` fails it on a column an earlier partial run already added.
// A file that fails halfway leaves the store in the state the repair exists
// to get out of.
//
// So every DDL statement in migrations/ that creates, drops or adds must say
// `IF [NOT] EXISTS`. Every file applied so far already does (the frozen list
// below is empty on the day this was written). Should a file ever need an
// exception, it is frozen there rather than fixed, because an applied
// migration is never edited. A new violation, in a new file or a new
// statement in an old one, fails here.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { splitStatements } from "./migrate";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

/** One statement that would not replay cleanly. */
interface Violation {
  file: string;
  /** The statement's first line, trimmed, which is enough to find it. */
  statement: string;
}

/**
 * The verbs that must carry a guard, and the guard each one takes.
 *
 * `MODIFY COLUMN` is left out: ClickHouse re-applies a MODIFY to a column
 * that already has that type as a no-op, so it replays cleanly as written.
 * `ADD INDEX` and `DROP INDEX` are included, because both refuse to run
 * twice without their guard.
 */
const GUARDED: ReadonlyArray<{ verb: RegExp; guard: RegExp }> = [
  {
    verb: /^CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\b/i,
    guard:
      /^CREATE\s+(?:OR\s+REPLACE\s+|(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+IF\s+NOT\s+EXISTS\b)/i,
  },
  {
    verb: /^DROP\s+(?:TABLE|VIEW)\b/i,
    guard: /^DROP\s+(?:TABLE|VIEW)\s+IF\s+EXISTS\b/i,
  },
];

/** Clauses inside an ALTER that must each carry a guard. */
const ALTER_CLAUSES: ReadonlyArray<{ clause: RegExp; guard: RegExp }> = [
  {
    clause: /\bADD\s+COLUMN\b(?!\s+IF\s+NOT\s+EXISTS)/gi,
    guard: /\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/i,
  },
  {
    clause: /\bDROP\s+COLUMN\b(?!\s+IF\s+EXISTS)/gi,
    guard: /\bDROP\s+COLUMN\s+IF\s+EXISTS\b/i,
  },
  {
    clause: /\bADD\s+INDEX\b(?!\s+IF\s+NOT\s+EXISTS)/gi,
    guard: /\bADD\s+INDEX\s+IF\s+NOT\s+EXISTS\b/i,
  },
  {
    clause: /\bDROP\s+INDEX\b(?!\s+IF\s+EXISTS)/gi,
    guard: /\bDROP\s+INDEX\s+IF\s+EXISTS\b/i,
  },
];

function firstLine(statement: string): string {
  return statement.split("\n")[0]?.trim() ?? "";
}

/** Every unguarded statement in one file. */
export function unguardedStatements(file: string, sql: string): Violation[] {
  const found: Violation[] = [];
  for (const statement of splitStatements(sql)) {
    const head = statement.replace(/\s+/g, " ");
    for (const { verb, guard } of GUARDED) {
      if (verb.test(head) && !guard.test(head)) {
        found.push({ file, statement: firstLine(statement) });
      }
    }
    if (/^ALTER\s+TABLE\b/i.test(head)) {
      for (const { clause } of ALTER_CLAUSES) {
        if (clause.test(head)) {
          found.push({ file, statement: firstLine(statement) });
          clause.lastIndex = 0;
          break;
        }
        clause.lastIndex = 0;
      }
    }
  }
  return found;
}

/**
 * Applied files with statements that predate this rule. Empty today. If an
 * entry is ever added, the file stays as it was applied and the list shrinks
 * only when that file is retired. Adding to it for new work is what this
 * test exists to refuse.
 */
const FROZEN: ReadonlyArray<Violation> = [];

function allViolations(): Violation[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .flatMap((file) =>
      unguardedStatements(
        file,
        readFileSync(join(migrationsDir, file), "utf8"),
      ),
    );
}

const key = (v: Violation) => `${v.file}: ${v.statement}`;

describe("unguardedStatements", () => {
  it("passes a guarded create, drop and add", () => {
    expect(
      unguardedStatements(
        "x.sql",
        [
          "CREATE TABLE IF NOT EXISTS t (a UInt8) ENGINE = MergeTree ORDER BY a;",
          "CREATE VIEW IF NOT EXISTS v AS SELECT * FROM t;",
          "CREATE OR REPLACE VIEW w AS SELECT * FROM t;",
          "DROP TABLE IF EXISTS gone;",
          "ALTER TABLE t ADD COLUMN IF NOT EXISTS b UInt8, ADD COLUMN IF NOT EXISTS c UInt8;",
          "ALTER TABLE t DROP COLUMN IF EXISTS b;",
          "ALTER TABLE t MODIFY COLUMN a UInt16;",
          "ALTER TABLE t ADD INDEX IF NOT EXISTS i a TYPE set(0) GRANULARITY 4;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  it("names an unguarded create, drop and add, once per statement", () => {
    const found = unguardedStatements(
      "y.sql",
      [
        "CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a;",
        "DROP TABLE gone;",
        "ALTER TABLE t\n    ADD COLUMN IF NOT EXISTS b UInt8,\n    ADD COLUMN c UInt8;",
        "ALTER TABLE t ADD INDEX i a TYPE set(0) GRANULARITY 4;",
      ].join("\n"),
    );
    expect(found.map((v) => v.statement)).toEqual([
      "CREATE TABLE t (a UInt8) ENGINE = MergeTree ORDER BY a",
      "DROP TABLE gone",
      "ALTER TABLE t",
      "ALTER TABLE t ADD INDEX i a TYPE set(0) GRANULARITY 4",
    ]);
  });

  it("ignores commentary, so a verb in prose is not a statement", () => {
    expect(
      unguardedStatements(
        "z.sql",
        "-- CREATE TABLE t would fail here\nCREATE TABLE IF NOT EXISTS t (a UInt8) ENGINE = MergeTree ORDER BY a;",
      ),
    ).toEqual([]);
  });
});

describe("migrations/ replays cleanly", () => {
  it("has no unguarded statement outside the frozen list", () => {
    const frozen = new Set(FROZEN.map(key));
    const fresh = allViolations().filter((v) => !frozen.has(key(v)));
    expect(
      fresh.map(key),
      "Each of these statements would fail a ledger-repair replay against a store that already carries " +
        "part of its file. Add IF NOT EXISTS / IF EXISTS. The frozen list above is for files already " +
        "applied in production and is not for new work.",
    ).toEqual([]);
  });

  it("carries nothing in the frozen list that the files no longer have", () => {
    // A retired or rewritten file should take its frozen entries with it, so
    // the list documents what is there and nothing else.
    const present = new Set(allViolations().map(key));
    const stale = FROZEN.map(key).filter((k) => !present.has(k));
    expect(stale).toEqual([]);
  });
});
