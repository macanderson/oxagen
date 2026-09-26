// migrate-ledger-repair.test.ts
//
// A row in `_migrations` says a filename was RECORDED. It does not say the
// file's statements ever reached the server, and the two came apart in
// production (#3698).
//
// `migrate.ts`'s pre-ledger baseline writes those rows on faith, for every file
// up to `PRE_LEDGER_BASELINE_CUTOVER`, and the apply loop skips a recorded file
// for ever. So a store classified as a pre-ledger deployment whose backlog had
// not in fact run against it ends up with the ledger reporting it current and
// the tables those files create permanently absent — with nothing left in the
// system that would ever run them again.
//
// `error_events` is the one that bit. It is created by
// `0020_error_events.sql` and by nothing else — `schema.sql`, which reapplies
// on every call outside the ledger, does not carry it — so production listed
// `0020` as applied, had no table, and every `captureError()` write failed with
// `Table oxagen.error_events does not exist`. captureError is the one component
// whose failure it cannot report: it swallows the rejection to stderr by
// design, so the error stream that an incident is meant to be read from was
// empty and green.
//
// The fix is that the runner asks the database rather than trusting the ledger.
// These tests pin the three things that has to get right: it replays the file
// whose table is missing, it replays the LATER file that alters that table (a
// recreated `error_events` without `execution_id` is worse than no table —
// ClickHouse drops the unknown field and stores the rest, so the insert
// succeeds and the column is empty for ever), and it leaves `0021`'s
// `DROP TABLE schema_conformance_events` alone whenever there is something
// there to drop.

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("./migration-lock", () => ({
  withMigrationLock: (run: () => Promise<unknown>) => run(),
}));

const commandMock = vi.hoisted(() =>
  vi.fn<(opts: { query: string }) => Promise<void>>(),
);
const bootstrapCloseMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const createClientMock = vi.hoisted(() =>
  vi.fn(() => ({ command: commandMock, close: bootstrapCloseMock })),
);
const requireEnvMock = vi.hoisted(() =>
  vi.fn(() => ({
    CLICKHOUSE_URL: "http://ch:8123",
    CLICKHOUSE_USERNAME: "default",
    CLICKHOUSE_PASSWORD: "pass",
    CLICKHOUSE_DATABASE: "oxagen",
  })),
);
const chCommandMock = vi.hoisted(() =>
  vi.fn<(opts: { query: string }) => Promise<void>>(),
);
const chQueryMock = vi.hoisted(() =>
  vi.fn<
    (opts: { query: string }) => Promise<{ json: <T>() => Promise<T[]> }>
  >(),
);
const chInsertMock = vi.hoisted(() =>
  vi.fn<
    (opts: {
      table: string;
      values: readonly unknown[];
      format: string;
    }) => Promise<void>
  >(),
);
const clickhouseSingletonMock = vi.hoisted(() =>
  vi.fn(() => ({
    command: chCommandMock,
    query: chQueryMock,
    insert: chInsertMock,
  })),
);
const closeClickhouseMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
const readFileSyncMock = vi.hoisted(() =>
  vi.fn<(path: unknown, enc: unknown) => string>(),
);
const readdirSyncMock = vi.hoisted(() => vi.fn<() => string[]>());
const existsSyncMock = vi.hoisted(() => vi.fn<() => boolean>());

vi.mock("@clickhouse/client", () => ({ createClient: createClientMock }));
vi.mock("@oxagen/config/env", () => ({ requireEnv: requireEnvMock }));
vi.mock("./clickhouse", () => ({
  clickhouse: clickhouseSingletonMock,
  closeClickhouse: closeClickhouseMock,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: readFileSyncMock,
    readdirSync: readdirSyncMock,
    existsSync: existsSyncMock,
  };
});

import {
  declaredMigrationTables,
  filesToReplay,
  migrate,
  tableStatements,
} from "./migrate";

/** The origin literal a pre-ledger deployment's `_migrations` carries. */
const ORIGIN_PRE_LEDGER = "oxagen ledger origin: pre-ledger deployment";

const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS token_usage (id UInt32) ENGINE=MergeTree() ORDER BY id;";

/** The three files that matter here, trimmed to the statements under test. */
const FILES: Record<string, string> = {
  "0020_error_events.sql":
    "-- the append-only runtime error stream\n" +
    "CREATE TABLE IF NOT EXISTS error_events (error_id UUID, message String) ENGINE = MergeTree() ORDER BY error_id;",
  "0021_schema_conformance_events_idempotency.sql":
    "DROP TABLE IF EXISTS schema_conformance_events;\n" +
    "CREATE TABLE IF NOT EXISTS schema_conformance_events (id UUID) ENGINE = MergeTree() ORDER BY id;",
  "0022_error_events_execution_id.sql":
    "ALTER TABLE error_events ADD COLUMN IF NOT EXISTS execution_id UUID;",
};

function jsonResult<T>(rows: T[]): { json: <U>() => Promise<U[]> } {
  return { json: async <U>() => rows as unknown as U[] };
}

/**
 * A pre-ledger production store: every file already recorded, and whichever
 * tables `tables` names actually present.
 */
function productionLike(tables: readonly string[]): void {
  chQueryMock.mockImplementation(async (opts: { query: string }) => {
    if (opts.query.includes("countIf"))
      return jsonResult([
        {
          ledger: "1",
          c: String(tables.length),
          ledger_comment: ORIGIN_PRE_LEDGER,
        },
      ]);
    if (opts.query.includes("SELECT name FROM system.tables"))
      return jsonResult(tables.map((name) => ({ name })));
    return jsonResult(Object.keys(FILES).map((filename) => ({ filename })));
  });
}

function sentQueries(): string[] {
  return chCommandMock.mock.calls.map((c) => (c[0] as { query: string }).query);
}

function recordedFilenames(): string[] {
  return chInsertMock.mock.calls
    .filter((c) => (c[0] as { table: string }).table === "_migrations")
    .flatMap(
      (c) => (c[0] as { values: readonly { filename: string }[] }).values,
    )
    .map((v) => v.filename);
}

beforeEach(() => {
  commandMock.mockResolvedValue(undefined);
  bootstrapCloseMock.mockResolvedValue(undefined);
  chCommandMock.mockResolvedValue(undefined);
  chInsertMock.mockResolvedValue(undefined);
  closeClickhouseMock.mockResolvedValue(undefined);
  existsSyncMock.mockReturnValue(true);
  readdirSyncMock.mockReturnValue(Object.keys(FILES));
  readFileSyncMock.mockImplementation((p: unknown) => {
    const path = String(p);
    for (const [file, sql] of Object.entries(FILES)) {
      if (path.endsWith(file)) return sql;
    }
    return SCHEMA_SQL;
  });
  productionLike(["token_usage", "schema_conformance_events", "_migrations"]);
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// The repair, end to end through migrate()
// ─────────────────────────────────────────────────────────────────────────────

describe("migrate() repairs a ledger that claims a table it does not have", () => {
  it("runs 0020 again when error_events is missing (#3698)", async () => {
    // The production state: the ledger lists every file, and the table the
    // error reporter writes to is not there. Before this repair the loop
    // skipped 0020 for ever and no run could create it.
    await migrate();

    expect(
      sentQueries().some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS error_events"),
      ),
    ).toBe(true);
  });

  it("runs 0022 again too, so the recreated table carries execution_id", async () => {
    // Replaying 0020 alone recreates error_events without the column 0022
    // adds, and ClickHouse would then DISCARD execution_id from every insert
    // rather than reject it — a silent write that reads as a complete row.
    await migrate();

    expect(
      sentQueries().some((q) =>
        q.includes("ADD COLUMN IF NOT EXISTS execution_id"),
      ),
    ).toBe(true);
  });

  it("leaves 0021's DROP alone while schema_conformance_events exists", async () => {
    // The file the ledger exists to protect. It is selected only when a table
    // it names is ABSENT, so in this state it is not selected at all and its
    // retained data survives.
    await migrate();

    expect(
      sentQueries().some((q) =>
        q.includes("DROP TABLE IF EXISTS schema_conformance_events"),
      ),
    ).toBe(false);
  });

  it("replays 0021 only when there is nothing there to drop", async () => {
    productionLike(["token_usage", "error_events", "_migrations"]);

    await migrate();

    // Both statements run: the DROP is a no-op against a table that is gone,
    // and the CREATE is the repair.
    expect(
      sentQueries().some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS schema_conformance_events"),
      ),
    ).toBe(true);
    // ...and error_events, which is present, is not touched.
    expect(
      sentQueries().some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS error_events"),
      ),
    ).toBe(false);
  });

  it("does nothing on a store whose tables are all present", async () => {
    productionLike([
      "token_usage",
      "error_events",
      "schema_conformance_events",
      "_migrations",
    ]);

    await migrate();

    const migrationQueries = sentQueries().filter(
      (q) => !q.includes("token_usage") && !q.includes("_migrations"),
    );
    expect(migrationQueries).toEqual([]);
  });

  it("does not write a second ledger row for a file it replayed", async () => {
    // The ledger is read with SELECT DISTINCT, so a duplicate would be
    // harmless — and a ledger that grows a row per repair stops reading as a
    // list of what has been applied.
    await migrate();

    expect(recordedFilenames()).toEqual([]);
  });

  it("says out loud which tables are missing and which files run again", async () => {
    // The whole incident was silence: the only thing that knew error_events
    // was absent was a stderr line inside the error reporter.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await migrate();

    const lines = stdoutSpy.mock.calls
      .map((c) => String(c[0]).trim())
      .filter((l) => l.startsWith("{"))
      .map(
        (l) =>
          JSON.parse(l) as {
            msg: string;
            missingTables?: string[];
            replaying?: string[];
          },
      );
    stdoutSpy.mockRestore();

    const announced = lines.find((l) => l.msg.includes("ledger repair"));
    expect(announced).toBeDefined();
    expect(announced!.missingTables).toEqual(["error_events"]);
    expect(announced!.replaying).toEqual([
      "0020_error_events.sql",
      "0022_error_events_execution_id.sql",
    ]);
  });

  it("stands down when the table list comes back empty", async () => {
    // A populated ledger and a database with no tables at all cannot both be
    // true, so an empty answer is a failed read, not a broken store. Replaying
    // every migration on a misread would be the larger accident.
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("countIf"))
        return jsonResult([
          { ledger: "1", c: "9", ledger_comment: ORIGIN_PRE_LEDGER },
        ]);
      if (opts.query.includes("SELECT name FROM system.tables"))
        return jsonResult([]);
      return jsonResult(Object.keys(FILES).map((filename) => ({ filename })));
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    await migrate();

    const warned = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes("could not read the table list"));
    stderrSpy.mockRestore();

    expect(warned).toBe(true);
    expect(
      sentQueries().some((q) =>
        q.includes("CREATE TABLE IF NOT EXISTS error_events"),
      ),
    ).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The parsers the selection rests on
// ─────────────────────────────────────────────────────────────────────────────

describe("tableStatements", () => {
  it("reads CREATE, DROP and ALTER in statement order", () => {
    expect(
      tableStatements(
        "DROP TABLE IF EXISTS a;\nCREATE TABLE IF NOT EXISTS a (id UInt32) ENGINE=MergeTree() ORDER BY id;\nALTER TABLE a ADD COLUMN b String;",
      ),
    ).toEqual([
      { verb: "drop", table: "a" },
      { verb: "create", table: "a" },
      { verb: "alter", table: "a" },
    ]);
  });

  it("reads a table whose CREATE has no IF NOT EXISTS", () => {
    expect(
      tableStatements("CREATE TABLE plain (id UInt32) ENGINE=Memory;"),
    ).toEqual([{ verb: "create", table: "plain" }]);
  });

  it("ignores a comment line above the statement", () => {
    // splitStatements strips them, which is what lets 0022 describe its
    // columns in prose without those names counting as declarations.
    expect(
      tableStatements(
        "-- ALTER TABLE ghost ADD COLUMN x String;\nALTER TABLE real ADD COLUMN x String;",
      ),
    ).toEqual([{ verb: "alter", table: "real" }]);
  });

  it("does not treat a view as a table", () => {
    // A view is in system.tables too, but nothing here has run against a
    // production store carrying one — the same call check-store-drift.sh makes.
    expect(
      tableStatements(
        "CREATE VIEW IF NOT EXISTS metered_token_usage AS SELECT 1;",
      ),
    ).toEqual([]);
  });

  it("strips a database prefix and backticks", () => {
    expect(
      tableStatements(
        "CREATE TABLE IF NOT EXISTS `oxagen`.`events` (id UInt32) ENGINE=Memory;",
      ),
    ).toEqual([{ verb: "create", table: "events" }]);
  });

  it("reads a rebuild directive as an ALTER of its table (#4297)", () => {
    // The rebuild keeps the table and changes its layout. Naming the table
    // lets a replay of the table's files include the rebuild, which does
    // nothing once the table has come back with the new key.
    expect(
      tableStatements(
        "-- move the key\nREBUILD TABLE tacho_events PARTITION BY toYYYYMM(received_at);",
      ),
    ).toEqual([{ verb: "alter", table: "tacho_events" }]);
  });
});

describe("declaredMigrationTables", () => {
  it("drops a table that a later migration removes", () => {
    const declared = declaredMigrationTables([
      {
        file: "0006.sql",
        sql: "CREATE TABLE agent_executions (id UInt32) ENGINE=Memory;",
      },
      { file: "0007.sql", sql: "DROP TABLE IF EXISTS agent_executions;" },
    ]);
    expect(declared.has("agent_executions")).toBe(false);
  });

  it("keeps a table a single file drops and recreates", () => {
    const declared = declaredMigrationTables([
      {
        file: "0021.sql",
        sql: FILES["0021_schema_conformance_events_idempotency.sql"]!,
      },
    ]);
    expect([...declared]).toEqual(["schema_conformance_events"]);
  });
});

describe("filesToReplay", () => {
  const files = Object.entries(FILES).map(([file, sql]) => ({ file, sql }));

  it("selects nothing when no declared table is missing", () => {
    expect(
      filesToReplay(
        files,
        new Set(Object.keys(FILES)),
        new Set(["error_events", "schema_conformance_events"]),
      ),
    ).toEqual({ files: [], missing: [] });
  });

  it("selects every recorded file that names the missing table", () => {
    expect(
      filesToReplay(
        files,
        new Set(Object.keys(FILES)),
        new Set(["schema_conformance_events"]),
      ),
    ).toEqual({
      files: ["0020_error_events.sql", "0022_error_events_execution_id.sql"],
      missing: ["error_events"],
    });
  });

  it("does not select a file the ledger never recorded", () => {
    // It is pending anyway, so the apply loop runs it — selecting it here
    // would only double-count.
    expect(
      filesToReplay(files, new Set(), new Set(["schema_conformance_events"]))
        .files,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The repository's own migrations
// ─────────────────────────────────────────────────────────────────────────────

describe("the tables this repository declares", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // node:fs is mocked for the runner tests above, so the real one is imported
  // here — these assertions are about the files on disk.
  let migrations: { file: string; sql: string }[] = [];
  let schema = "";

  beforeAll(async () => {
    const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
    migrations = fs
      .readdirSync(join(here, "migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((file) => ({
        file,
        sql: fs.readFileSync(join(here, "migrations", file), "utf8"),
      }));
    schema = fs.readFileSync(join(here, "schema.sql"), "utf8");
  });

  it("creates error_events in migrations/ and nowhere else", () => {
    // The fact that made #3698 unrecoverable. schema.sql reapplies on every
    // call outside the ledger, so a table it carries comes back by itself; a
    // table only migrations/ carries does not, once its filename is recorded.
    expect(declaredMigrationTables(migrations).has("error_events")).toBe(true);
    expect(schema).not.toMatch(/CREATE\s+TABLE[^;]*\berror_events\b/i);
  });

  it("names error_events in 0020 and in 0022", () => {
    // Both have to replay together, or the recreated table is missing the
    // column agent.debug.trace joins on.
    const naming = migrations
      .filter(({ sql }) =>
        tableStatements(sql).some((s) => s.table === "error_events"),
      )
      .map(({ file }) => file);
    expect(naming).toEqual([
      "0020_error_events.sql",
      "0022_error_events_execution_id.sql",
    ]);
  });

  it("replays the tacho_events rebuild with the files that create the table", () => {
    // A lost tacho_events comes back from 0027 with the new key, so 0034 runs
    // after it and finds nothing to do. The shadow table the rebuild uses is
    // never declared: no file creates it, so the repair never waits for it.
    const recorded = new Set(migrations.map(({ file }) => file));
    const present = declaredMigrationTables(migrations);
    present.delete("tacho_events");
    expect(filesToReplay(migrations, recorded, present)).toEqual({
      files: [
        "0027_tacho_events.sql",
        "0028_tacho_observed_changes.sql",
        "0031_drop_tacho_events_anthropic_user_email.sql",
        "0032_tacho_events_ttl.sql",
        "0033_tacho_events_part_settings.sql",
        "0034_tacho_events_partition_received_at.sql",
        "0035_tacho_events_request_effort_policy_rules.sql",
      ],
      missing: ["tacho_events"],
    });
    expect(
      declaredMigrationTables(migrations).has("tacho_events_rebuild"),
    ).toBe(false);
  });

  it("does not declare a table a later migration drops", () => {
    const declared = declaredMigrationTables(migrations);
    // 0010 drops these outright; 0006's agent_executions is dropped by 0007
    // and 0005's session_recaps by 0010.
    for (const dead of [
      "traces",
      "spans",
      "api_key_events",
      "agent_logs",
      "session_recaps",
      "agent_executions",
    ]) {
      expect(declared.has(dead)).toBe(false);
    }
  });
});
