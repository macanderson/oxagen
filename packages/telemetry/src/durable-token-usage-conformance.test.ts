// durable-token-usage-conformance.test.ts
//
// `durable_token_usage` (migration 0029) is a copy of `token_usage`'s columns
// plus `usage_event_id`, and `metered_token_usage` is the UNION of the two.
// The copy was taken once, by `CREATE TABLE ... AS SELECT * FROM token_usage
// WHERE 0`, so it does not follow `token_usage` afterwards: a column added to
// one arm in a later migration and forgotten on the other silently splits the
// two. The UNION then fails to prepare, or, worse for a column with a
// DEFAULT, the durable arm stores every row without it and the outbox insert
// still resolves, because ClickHouse drops a field the table lacks
// (`input_format_skip_unknown_fields = 1`; see error-events-conformance).
//
// This test reads both column lists out of the SQL this repository ships and
// compares them, and then checks the row `insertDurableTokenUsage` sends
// against the durable table's list. No database, no skip. The parser is the
// one error-events-conformance uses, generalised by table name and kept here
// rather than imported from a test file.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

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
const schemaFile = join(here, "schema.sql");

/** The migration that took the copy. Files after it may drift the two arms. */
const COPY_MIGRATION = "0029_durable_token_usage.sql";

/** `-- comment` lines removed, so a column named in prose is not declared. */
function withoutComments(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
}

/** Column names in the parenthesised body of `CREATE TABLE <table> (...)`. */
function createBodyColumns(sql: string, table: string): string[] {
  const create = new RegExp(
    `CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${table}\\s*\\(`,
    "i",
  ).exec(sql);
  if (!create) return [];
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
  return parts
    .map((part) => /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(part)?.[1])
    .filter((name): name is string => name !== undefined)
    .filter(
      (name) =>
        !/^(INDEX|PROJECTION|CONSTRAINT|PRIMARY|ORDER|PARTITION|TTL)$/i.test(
          name,
        ),
    );
}

/**
 * Apply one file's `ALTER TABLE <table> ADD|DROP COLUMN` to a column set.
 *
 * Per statement, because one ALTER can carry several comma-separated
 * `ADD COLUMN` clauses (0015 adds `trace_id` and `span_id` in one), and a
 * regex anchored on `ALTER TABLE` would see only the first.
 */
function applyAlters(sql: string, table: string, columns: Set<string>): void {
  const alter = new RegExp(`^\\s*ALTER\\s+TABLE\\s+${table}\\b`, "i");
  for (const statement of sql.split(/;\s*$/m)) {
    if (!alter.test(statement)) continue;
    for (const add of statement.matchAll(
      /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      if (add[1]) columns.add(add[1]);
    }
    for (const drop of statement.matchAll(
      /DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      if (drop[1]) columns.delete(drop[1]);
    }
  }
}

/** Every migration file, sorted, with comments removed. */
function migrationFiles(): Array<{ file: string; sql: string }> {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: withoutComments(readFileSync(join(migrationsDir, file), "utf8")),
    }));
}

/**
 * `token_usage`'s columns once schema.sql and every migration have run.
 * schema.sql is where the table is created; the migrations only alter it.
 */
export function declaredTokenUsageColumns(): Set<string> {
  const columns = new Set(
    createBodyColumns(
      withoutComments(readFileSync(schemaFile, "utf8")),
      "token_usage",
    ),
  );
  for (const { sql } of migrationFiles())
    applyAlters(sql, "token_usage", columns);
  return columns;
}

/**
 * `durable_token_usage`'s columns: `token_usage`'s as they stood when 0029
 * copied them (schema.sql's create body plus the alters up to and including
 * 0029), plus `usage_event_id`, plus every later alter that names the
 * durable table itself.
 */
export function declaredDurableTokenUsageColumns(): Set<string> {
  const columns = new Set(
    createBodyColumns(
      withoutComments(readFileSync(schemaFile, "utf8")),
      "token_usage",
    ),
  );
  for (const { file, sql } of migrationFiles()) {
    if (file <= COPY_MIGRATION) applyAlters(sql, "token_usage", columns);
    if (file === COPY_MIGRATION) columns.add("usage_event_id");
    if (file >= COPY_MIGRATION)
      applyAlters(sql, "durable_token_usage", columns);
  }
  return columns;
}

let sentRow: Record<string, unknown>;

beforeAll(async () => {
  const { insertDurableTokenUsage, stampTokenUsage } = await import(
    "./clickhouse"
  );
  // The outbox stages a row `recordTokenUsage` has already stamped, so the
  // row sent here is a stamped one, as in production.
  const [stamped] = stampTokenUsage([
    {
      execution_step_id: null,
      org_id: "6f1b2c3d-0000-4000-8000-000000000001",
      workspace_id: "6f1b2c3d-0000-4000-8000-000000000002",
      model: "anthropic/claude-sonnet-5",
      provider: "anthropic",
      input_tokens: 10,
      output_tokens: 2,
      cached_tokens: 0,
      cache_write_tokens: 0,
      cost_usd_micros: 30,
      duration_ms: 5,
      surface: "api",
      prompt_hash: "conformance",
      created_at: new Date().toISOString(),
    },
  ]);
  await insertDurableTokenUsage(
    "6f1b2c3d-0000-4000-8000-000000000003",
    stamped!,
  );
  sentRow = (inserts.at(-1)?.values[0] ?? {}) as Record<string, unknown>;
});

describe("the two arms of metered_token_usage", () => {
  it("reads token_usage's create body and its later ADD COLUMNs", () => {
    const declared = declaredTokenUsageColumns();
    // Parser guard: an empty set would satisfy every assertion below.
    expect(declared.size).toBeGreaterThan(10);
    expect(declared).toContain("execution_step_id");
    expect(declared).toContain("cost_usd_micros");
    // 0026's ADD COLUMN, past the CODEC(...) commas in the create body.
    expect(declared).toContain("cache_write_tokens");
    // 0015 adds both in one ALTER; the second clause must not be lost.
    expect(declared).toContain("trace_id");
    expect(declared).toContain("span_id");
    // 0023's principal attribution.
    expect(declared).toContain("principal_id");
    expect(declared).not.toContain("idx_token_model");
  });

  it("declares the same columns on both, plus the delivery id on the durable arm", () => {
    const tokenUsage = declaredTokenUsageColumns();
    const durable = declaredDurableTokenUsageColumns();
    const expected = new Set([...tokenUsage, "usage_event_id"]);
    const missingOnDurable = [...expected].filter((c) => !durable.has(c));
    const extraOnDurable = [...durable].filter((c) => !expected.has(c));
    expect(
      missingOnDurable,
      `token_usage gained ${missingOnDurable.join(", ")} after ${COPY_MIGRATION} and durable_token_usage did not. ` +
        "Add the same ALTER for durable_token_usage in the migration, or metered_token_usage stops preparing " +
        "and the outbox's insert silently drops the column.",
    ).toEqual([]);
    expect(
      extraOnDurable,
      `durable_token_usage carries ${extraOnDurable.join(", ")} that token_usage does not. ` +
        "Add the same ALTER for token_usage, or the UNION in metered_token_usage stops preparing.",
    ).toEqual([]);
  });
});

describe("insertDurableTokenUsage payload conformance", () => {
  it("sends the delivery id and the usage columns", () => {
    expect(Object.keys(sentRow).length).toBeGreaterThan(10);
    expect(sentRow.usage_event_id).toBe("6f1b2c3d-0000-4000-8000-000000000003");
    expect(sentRow).toHaveProperty("cost_usd_micros");
    expect(sentRow).toHaveProperty("prompt_hash");
  });

  it("sends no field the durable table does not declare", () => {
    const declared = declaredDurableTokenUsageColumns();
    const unknown = Object.keys(sentRow).filter((key) => !declared.has(key));
    expect(
      unknown,
      `insertDurableTokenUsage sends ${unknown.join(", ")}, which migrations/ does not declare on durable_token_usage. ` +
        "ClickHouse discards an unknown field silently, so every delivered row would be stored without it.",
    ).toEqual([]);
  });

  it("writes to durable_token_usage in JSONEachRow", () => {
    expect(inserts.at(-1)?.table).toBe("durable_token_usage");
    expect(inserts.at(-1)?.format).toBe("JSONEachRow");
  });
});
