// error-events-conformance.test.ts
//
// Does the row `captureError()` actually sends match the `error_events` table
// this repository migrates?
//
// WHY THIS EXISTS (#3698)
//
// `error_events` held zero rows in production while every runtime was calling
// `captureError()` on every unhandled 500. The capture path is fire-and-forget
// by design — `insertErrorEvents(...).catch(...)` swallows the rejection to a
// stderr line — so a rejected insert costs nothing the caller can see, and the
// error reporter is the one component whose failure it cannot report.
//
// A field the table does not have is NOT an error. ClickHouse ships
// `input_format_skip_unknown_fields = 1` (verified against the 24.8 image this
// repo runs), so an unknown key in a `JSONEachRow` payload is silently
// DISCARDED and the rest of the row is stored. That is the worse failure of
// the two available: the insert resolves, the row appears, monitoring is
// green, and one column is quietly absent from every error ever captured.
//
// `execution_id` is the column that shows what it costs. It exists so
// `agent.debug.trace` (debug_with_trace) can pull every error for one agent
// execution; dropped at the boundary, that join matches nothing, for every
// execution, and reads as "this run logged no errors". The two sides drift
// independently — a column is added to `ErrorEventRow` in `clickhouse.ts`, and
// the migration is forgotten or (see `migrate.ts`'s pre-ledger baseline)
// recorded as applied without ever being executed — and nothing before this
// test compared them.
//
// `error-reporting.test.ts` cannot catch it: it mocks `./clickhouse`, so it
// asserts what captureError() hands the boundary and never what the boundary
// would send to a real table. The integration suite next door
// (error-events-write.integration.test.ts) does exercise a live write, and
// skips when local ClickHouse is not running — so it is not a gate in CI.
//
// This is the gate that always runs: the ClickHouse client is mocked to
// capture the outgoing payload, the table's columns are read out of the SQL in
// `migrations/`, and the two sets are compared. No database, no skip.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

/** Every `insert()` the mocked client received, in order. */
const inserts: Array<{ table: string; values: unknown[]; format: string }> = [];

vi.mock("@clickhouse/client", () => ({
  createClient: () => ({
    insert: (params: { table: string; values: unknown[]; format: string }) => {
      inserts.push(params);
      return Promise.resolve({ executed: true });
    },
    query: () => Promise.resolve({ json: () => Promise.resolve([]) }),
    command: () => Promise.resolve({}),
    close: () => Promise.resolve(),
  }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "migrations");

/**
 * The columns `error_events` has once every migration file has been applied.
 *
 * Read from the SQL rather than from a live `DESCRIBE`, so this runs in plain
 * CI with no service container — the declared schema is what a correct
 * deployment carries, and a deployment that carries less is the separate
 * problem `infra/tools/check-store-drift.sh` reports.
 *
 * Two shapes contribute: the `CREATE TABLE error_events (...)` body, and every
 * later `ALTER TABLE error_events ADD COLUMN`. `INDEX` lines inside the create
 * body are skipped — they sit in the same parenthesised list as the columns
 * and are not columns.
 */
export function declaredErrorEventColumns(dir: string): Set<string> {
  const columns = new Set<string>();

  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    // Comments are stripped first: `0022` describes the columns it adds in
    // prose above the statements, and a commented column name is not declared.
    const sql = readFileSync(join(dir, file), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    const create =
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?error_events\s*\(/i.exec(sql);
    if (create) {
      // Walk from the opening paren to its match so the column list is bounded
      // by the statement rather than by a guess at where it ends.
      let depth = 0;
      let end = create.index + create[0].length - 1;
      for (let i = end; i < sql.length; i++) {
        if (sql[i] === "(") depth++;
        else if (sql[i] === ")") {
          depth--;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const body = sql.slice(create.index + create[0].length, end);
      // Split on top-level commas only: `LowCardinality(String)` and
      // `CODEC(DoubleDelta, ZSTD(1))` both carry commas inside parens.
      let level = 0;
      let current = "";
      const parts: string[] = [];
      for (const ch of body) {
        if (ch === "(") level++;
        if (ch === ")") level--;
        if (ch === "," && level === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += ch;
      }
      parts.push(current);

      for (const part of parts) {
        const name = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1];
        if (!name) continue;
        if (
          /^(INDEX|PROJECTION|CONSTRAINT|PRIMARY|ORDER|PARTITION|TTL)$/i.test(
            name,
          )
        )
          continue;
        columns.add(name);
      }
    }

    for (const alter of sql.matchAll(
      /ALTER\s+TABLE\s+error_events\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      const name = alter[1];
      if (name) columns.add(name);
    }

    for (const drop of sql.matchAll(
      /ALTER\s+TABLE\s+error_events\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      const name = drop[1];
      if (name) columns.delete(name);
    }
  }

  return columns;
}

let sentRow: Record<string, unknown>;
let declared: Set<string>;

beforeAll(async () => {
  declared = declaredErrorEventColumns(migrationsDir);

  const { insertErrorEvents } = await import("./clickhouse");
  await insertErrorEvents([
    {
      error_id: "6f1b2c3d-0000-4000-8000-000000000001",
      org_id: null,
      workspace_id: null,
      severity: "error",
      source: "api",
      error_class: "TypeError",
      message: "conformance probe",
      stack: "at conformance",
      capability: "",
      request_id: "",
      fingerprint: "0".repeat(32),
      created_at: new Date().toISOString(),
      execution_id: null,
      step_id: null,
    },
  ]);

  const values = inserts.at(-1)?.values;
  sentRow = (values?.[0] ?? {}) as Record<string, unknown>;
});

describe("declaredErrorEventColumns", () => {
  it("reads the create body and the later ADD COLUMNs", () => {
    // A guard on the parser itself: if it silently matched nothing, every
    // assertion below would pass against an empty set and this file would be
    // decorative — the exact failure mode it exists to prevent.
    expect(declared.size).toBeGreaterThan(10);
    expect(declared).toContain("error_id");
    expect(declared).toContain("message");
    // 0020's create body, past the commas inside CODEC(...) and
    // LowCardinality(...).
    expect(declared).toContain("created_at");
    expect(declared).toContain("severity");
    // 0022's ALTERs, which the create body does not carry.
    expect(declared).toContain("execution_id");
    expect(declared).toContain("step_id");
  });

  it("does not mistake an INDEX line for a column", () => {
    expect(declared).not.toContain("idx_error_severity");
    expect(declared).not.toContain("idx_error_fingerprint");
    expect(declared).not.toContain("idx_error_execution");
  });
});

describe("insertErrorEvents payload conformance", () => {
  it("sends at least the columns that carry the error", () => {
    // Sanity on the capture side, for the same reason as above: an empty
    // payload would satisfy "every field exists" vacuously.
    expect(Object.keys(sentRow).length).toBeGreaterThan(10);
    expect(sentRow).toHaveProperty("message");
    expect(sentRow).toHaveProperty("stack");
    expect(sentRow).toHaveProperty("fingerprint");
  });

  it("sends no field the migrated table does not have", () => {
    // THE assertion. ClickHouse does not reject a field the table lacks — with
    // `input_format_skip_unknown_fields = 1` it drops that field and stores
    // the rest, so the insert resolves and the row appears complete. Nothing
    // downstream can tell a column that was never written from one that was
    // written empty, which is why this has to be caught here.
    const unknown = Object.keys(sentRow).filter((key) => !declared.has(key));
    expect(
      unknown,
      `insertErrorEvents sends ${unknown.join(", ")}, which migrations/ does not declare on error_events. ` +
        "ClickHouse discards unknown fields silently, so every captured error would be stored without them " +
        "and nothing would report it. Add the column in a new migration.",
    ).toEqual([]);
  });

  it("stamps the trace columns the table declares", () => {
    // trace_id/span_id are stamped at the boundary, not by the caller, so they
    // reach the table only if the boundary adds them — and they are columns,
    // so an unstamped insert is not an error but an unjoinable row.
    expect(sentRow).toHaveProperty("trace_id");
    expect(sentRow).toHaveProperty("span_id");
  });

  it("coalesces an absent scope to the nil UUID rather than null", () => {
    // org_id / workspace_id / execution_id are non-nullable UUID columns. A
    // null reaches the UUID parser as the four characters `null`, which
    // over-reads and aborts the row (CANNOT_PARSE_INPUT_ASSERTION_FAILED) —
    // the same trap token_usage.execution_step_id documents.
    const nil = "00000000-0000-0000-0000-000000000000";
    expect(sentRow.org_id).toBe(nil);
    expect(sentRow.workspace_id).toBe(nil);
    expect(sentRow.execution_id).toBe(nil);
    // step_id is Nullable(UUID), so null is the right "no step" here.
    expect(sentRow.step_id).toBeNull();
  });

  it("writes to error_events in JSONEachRow", () => {
    expect(inserts.at(-1)?.table).toBe("error_events");
    expect(inserts.at(-1)?.format).toBe("JSONEachRow");
  });
});
