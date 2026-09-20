// migrate-runner.test.ts
//
// Unit tests for ensureDatabase(), migrate(), and the isDirectRun top-level
// block from migrate.ts.
//
// splitStatements() is already covered in migrate.test.ts — this file focuses
// on the I/O-dependent functions that need mocked deps.
//
// Mocking strategy (matching clickhouse.test.ts patterns):
//   - @clickhouse/client   → createClient factory
//   - @oxagen/config/env   → requireEnv
//   - ./clickhouse         → clickhouse() singleton + closeClickhouse
//   - node:fs              → readFileSync, readdirSync, existsSync

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

vi.mock("./migration-lock", () => ({
  withMigrationLock: (run: () => Promise<unknown>) => run(),
}));

// ── Mock factories ─────────────────────────────────────────────────────────────
// vi.hoisted() runs before vi.mock(), making refs available to the factories.

/** bootstrap client's command (used by ensureDatabase for CREATE DATABASE) */
const commandMock = vi.hoisted(() =>
  vi.fn<(opts: { query: string }) => Promise<void>>(),
);
/** bootstrap client's close (called in the ensureDatabase finally block) */
const bootstrapCloseMock = vi.hoisted(() => vi.fn<() => Promise<void>>());
/** createClient factory — returns the bootstrap client object */
const createClientMock = vi.hoisted(() =>
  vi.fn((_config?: Record<string, unknown>) => ({
    command: commandMock,
    close: bootstrapCloseMock,
  })),
);

/** requireEnv — returns ClickHouse connection env vars */
const requireEnvMock = vi.hoisted(() =>
  vi.fn(() => ({
    CLICKHOUSE_URL: "http://ch:8123",
    CLICKHOUSE_USERNAME: "default",
    CLICKHOUSE_PASSWORD: "pass",
    CLICKHOUSE_DATABASE: "telemetry",
  })),
);

/** clickhouse() singleton client's command (used for schema + migrations) */
const chCommandMock = vi.hoisted(() =>
  vi.fn<(opts: { query: string }) => Promise<void>>(),
);
/**
 * clickhouse() singleton client's query — used by the ledger to (a) count
 * pre-existing tables (the fresh-install / existing-deployment fork) and
 * (b) read which migrations/*.sql filenames are already recorded.
 * Distinguishes the two by sniffing the query text, same as a real
 * ClickHouse response shape (`{ json: () => Promise<T[]> }`).
 */
const chQueryMock = vi.hoisted(() =>
  vi.fn<
    (opts: { query: string }) => Promise<{ json: <T>() => Promise<T[]> }>
  >(),
);
/** clickhouse() singleton client's insert — used to record applied migrations. */
const chInsertMock = vi.hoisted(() =>
  vi.fn<
    (opts: {
      table: string;
      values: readonly unknown[];
      format: string;
    }) => Promise<void>
  >(),
);
/** clickhouse() singleton factory */
const clickhouseSingletonMock = vi.hoisted(() =>
  vi.fn(() => ({
    command: chCommandMock,
    query: chQueryMock,
    insert: chInsertMock,
  })),
);
/** closeClickhouse — called after migration in the direct-run success path */
const closeClickhouseMock = vi.hoisted(() => vi.fn<() => Promise<void>>());

/** readFileSync — returns SQL content */
const readFileSyncMock = vi.hoisted(() =>
  vi.fn<(path: unknown, enc: unknown) => string>(),
);
/** readdirSync — returns filenames in migrations/ */
const readdirSyncMock = vi.hoisted(() => vi.fn<() => string[]>());
/** existsSync — controls whether migrations/ directory exists */
const existsSyncMock = vi.hoisted(() => vi.fn<() => boolean>());

// ── Module mocks ───────────────────────────────────────────────────────────────

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

// ── Import under test ──────────────────────────────────────────────────────────

import {
  AmbiguousLedgerOriginError,
  decideLedgerAction,
  migrate,
} from "./migrate";

/** The two origin literals, kept in step with migrate.ts by the tests below. */
const ORIGIN_PRE_LEDGER = "oxagen ledger origin: pre-ledger deployment";
const ORIGIN_FRESH = "oxagen ledger origin: fresh database";

// ── Shared SQL fixtures ────────────────────────────────────────────────────────

const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS t (id UInt32) ENGINE=MergeTree() ORDER BY id;";
const MIGRATION_SQL = "ALTER TABLE t ADD COLUMN x String;";

/** Wraps a plain array the way the real `@clickhouse/client` result does. */
function jsonResult<T>(rows: T[]): { json: <U>() => Promise<U[]> } {
  return { json: async <U>() => rows as unknown as U[] };
}

/** Filenames this run wrote to the ledger, in order. */
function recordedFilenames(): string[] {
  return chInsertMock.mock.calls
    .filter((c) => (c[0] as { table: string }).table === "_migrations")
    .flatMap(
      (c) => (c[0] as { values: readonly { filename: string }[] }).values,
    )
    .map((v) => v.filename);
}

function defaultMocks(): void {
  commandMock.mockResolvedValue(undefined);
  bootstrapCloseMock.mockResolvedValue(undefined);
  chCommandMock.mockResolvedValue(undefined);
  closeClickhouseMock.mockResolvedValue(undefined);
  readFileSyncMock.mockReturnValue(SCHEMA_SQL);
  readdirSyncMock.mockReturnValue(["0001_init.sql"]);
  existsSyncMock.mockReturnValue(true);
  // Default: a fresh database (no pre-existing tables) with nothing yet
  // recorded in the ledger — every test that doesn't override this exercises
  // the "run everything, then record it" path, matching the pre-ledger
  // behaviour these tests were written against.
  chQueryMock.mockImplementation(async (opts: { query: string }) => {
    if (opts.query.includes("system.tables")) return jsonResult([{ c: "0" }]);
    return jsonResult([]); // ledger SELECT DISTINCT filename
  });
  chInsertMock.mockResolvedValue(undefined);
}

beforeEach(() => {
  defaultMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// migrate() — happy path
// ─────────────────────────────────────────────────────────────────────────────

describe("migrate() — happy path", () => {
  it("creates a bootstrap client with env-sourced connection params", async () => {
    requireEnvMock.mockReturnValue({
      CLICKHOUSE_URL: "https://cloud.ch:9440",
      CLICKHOUSE_USERNAME: "my_user",
      CLICKHOUSE_PASSWORD: "my_pass",
      CLICKHOUSE_DATABASE: "my_db",
    });

    await migrate();

    expect(createClientMock).toHaveBeenCalledTimes(1);
    const config = createClientMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(config.url).toBe("https://cloud.ch:9440");
    expect(config.username).toBe("my_user");
    expect(config.password).toBe("my_pass");
    // Bootstrap client has no database bound — it connects at the server level
    // to issue CREATE DATABASE.
    expect(config).not.toHaveProperty("database");
  });

  it("sends CREATE DATABASE IF NOT EXISTS with the configured db name", async () => {
    requireEnvMock.mockReturnValue({
      CLICKHOUSE_URL: "http://ch:8123",
      CLICKHOUSE_USERNAME: "u",
      CLICKHOUSE_PASSWORD: "p",
      CLICKHOUSE_DATABASE: "telemetry_test",
    });

    await migrate();

    expect(commandMock).toHaveBeenCalledTimes(1);
    const { query } = commandMock.mock.calls[0]![0] as { query: string };
    expect(query).toMatch(/CREATE DATABASE IF NOT EXISTS/);
    expect(query).toContain("telemetry_test");
  });

  it("always closes the bootstrap client via the finally block", async () => {
    await migrate();
    expect(bootstrapCloseMock).toHaveBeenCalledTimes(1);
  });

  it("applies schema.sql statements against the clickhouse singleton", async () => {
    readFileSyncMock.mockReturnValue(SCHEMA_SQL);
    existsSyncMock.mockReturnValue(false); // skip migrations

    await migrate();

    expect(chCommandMock).toHaveBeenCalled();
    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("CREATE TABLE"))).toBe(true);
  });

  it("handles schema.sql with multiple semicolon-separated statements", async () => {
    readFileSyncMock.mockReturnValue(
      "CREATE TABLE a (id UInt32) ENGINE=MergeTree() ORDER BY id;\n" +
        "CREATE TABLE b (id UInt32) ENGINE=MergeTree() ORDER BY id;",
    );
    existsSyncMock.mockReturnValue(false);

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("CREATE TABLE a"))).toBe(true);
    expect(queries.some((q) => q.includes("CREATE TABLE b"))).toBe(true);
  });

  it("reads and applies migration files in alphabetical order", async () => {
    readdirSyncMock.mockReturnValue(["0002_b.sql", "0001_a.sql"]); // unsorted
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "ALTER TABLE t ADD COLUMN a String;";
      if (path.endsWith("0002_b.sql"))
        return "ALTER TABLE t ADD COLUMN b String;";
      return SCHEMA_SQL;
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("ADD COLUMN a"))).toBe(true);
    expect(queries.some((q) => q.includes("ADD COLUMN b"))).toBe(true);

    // Verify sort order: 0001_a ran before 0002_b
    const aIdx = queries.findIndex((q) => q.includes("ADD COLUMN a"));
    const bIdx = queries.findIndex((q) => q.includes("ADD COLUMN b"));
    expect(aIdx).toBeLessThan(bIdx);
  });

  it("skips migration directory scan when it does not exist", async () => {
    existsSyncMock.mockReturnValue(false);

    await migrate();

    expect(readdirSyncMock).not.toHaveBeenCalled();
  });

  it("filters out non-.sql files from migrations directory", async () => {
    readdirSyncMock.mockReturnValue([
      "0001_init.sql",
      "README.md",
      ".DS_Store",
      "0002_next.sql",
    ]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith(".sql")) return MIGRATION_SQL;
      return SCHEMA_SQL;
    });

    await migrate();

    const readPaths = readFileSyncMock.mock.calls.map((c) => String(c[0]));
    const migrationPaths = readPaths.filter((p) => !p.includes("schema"));
    // Only .sql files were read from the migrations directory
    expect(migrationPaths.every((p) => p.endsWith(".sql"))).toBe(true);
    expect(migrationPaths).toHaveLength(2);
  });

  it("applies multiple statements from a migration file", async () => {
    readdirSyncMock.mockReturnValue(["0001_multi.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      if (String(p).endsWith("0001_multi.sql")) {
        return (
          "ALTER TABLE t ADD COLUMN c String;\n" +
          "ALTER TABLE t ADD COLUMN d String;"
        );
      }
      return SCHEMA_SQL;
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("ADD COLUMN c"))).toBe(true);
    expect(queries.some((q) => q.includes("ADD COLUMN d"))).toBe(true);
  });

  it("uses a 60 s request_timeout on the bootstrap client for cloud cold-start tolerance", async () => {
    await migrate();

    const config = createClientMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(config.request_timeout).toBe(60_000);
  });

  it("covers String(err) branch (line 53) and for-loop retry (line 58) with non-Error transient", async () => {
    // Uses an immediately-resolving setTimeout mock (no fake timers) so V8's
    // async coverage properly attributes the for-loop back-edge (line 58) and the
    // String(err) ternary arm (line 53) — both of which fake-timer mode misses.
    const origSetTimeout = globalThis.setTimeout;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).setTimeout = (fn: () => void) => {
      void Promise.resolve().then(fn);
      return 0;
    };
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      // Throw a plain string (not an Error) on attempt 1 → exercises String(err).
      // Succeed on attempt 2 → exercises the for-loop back-edge (line 58).
      commandMock
        .mockRejectedValueOnce("non-error string transient")
        .mockResolvedValue(undefined);

      await migrate();

      // The String(err) branch ran: the log's err field is the raw string.
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      const written = stderrSpy.mock.calls[0]![0] as string;
      const parsed = JSON.parse(written.trim()) as {
        level: string;
        err: string;
      };
      expect(parsed.level).toBe("warn");
      expect(parsed.err).toBe("non-error string transient");
      // Succeeded on attempt 2 → only one CREATE DATABASE call logged as warning,
      // then the second attempt resolved.
      expect(commandMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.setTimeout = origSetTimeout;
      stderrSpy.mockRestore();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureDatabase() — retry behaviour (accessed through migrate())
// Uses fake timers to avoid 15 s real waits.
// ─────────────────────────────────────────────────────────────────────────────

describe("ensureDatabase() — retry behaviour", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries and succeeds when a later attempt passes", async () => {
    const transient = new Error("connection refused");
    commandMock
      .mockRejectedValueOnce(transient)
      .mockRejectedValueOnce(transient)
      .mockResolvedValue(undefined);

    const p = migrate();
    // Two failures → two 15 s delays = 30 s total
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBeUndefined();

    expect(commandMock).toHaveBeenCalledTimes(3);
    // Bootstrap client is still closed exactly once via the finally block
    expect(bootstrapCloseMock).toHaveBeenCalledTimes(1);
  });

  it("writes a structured warn to stderr for each transient failure (not the last)", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    commandMock
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValue(undefined);

    const p = migrate();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toBeUndefined();

    // One warn for the one transient failure
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const written = stderrSpy.mock.calls[0]![0] as string;
    const parsed = JSON.parse(written.trim()) as {
      level: string;
      msg: string;
      err: string;
    };
    expect(parsed.level).toBe("warn");
    expect(parsed.msg).toContain("cold-start");
    expect(typeof parsed.err).toBe("string");

    stderrSpy.mockRestore();
  });

  it("includes attempt progress (n/5) in the warn message", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    commandMock
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValue(undefined);

    const p = migrate();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toBeUndefined();

    // First warn: attempt 1/5, second warn: attempt 2/5
    expect(stderrSpy).toHaveBeenCalledTimes(2);
    const first = stderrSpy.mock.calls[0]![0] as string;
    const second = stderrSpy.mock.calls[1]![0] as string;
    expect(first).toContain("1/5");
    expect(second).toContain("2/5");

    stderrSpy.mockRestore();
  });

  it("throws after exhausting all 5 attempts", async () => {
    const fatal = new Error("service unavailable");
    commandMock.mockRejectedValue(fatal);

    const p = migrate();
    // Attach the rejection handler BEFORE advancing timers so the rejection
    // is not unhandled when advanceTimersByTimeAsync fires it.
    const assertion = expect(p).rejects.toThrow("service unavailable");
    // 4 delays (attempts 1–4 each wait; attempt 5 throws immediately)
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(commandMock).toHaveBeenCalledTimes(5);
    // Finally block still closes the bootstrap client on failure
    expect(bootstrapCloseMock).toHaveBeenCalledTimes(1);
  });

  it("does not write a warn for the 5th (last) attempt failure before rethrowing", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    commandMock.mockRejectedValue(new Error("always fails"));

    const p = migrate();
    // Attach rejection handler first so the rejection is not unhandled
    const assertion = expect(p).rejects.toThrow("always fails");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    // 5 attempts → 4 warns (attempt 5 immediately rethrows, no warn)
    const warnCalls = stderrSpy.mock.calls.filter((c) => {
      try {
        const parsed = JSON.parse(String(c[0])) as { level?: string };
        return parsed.level === "warn";
      } catch {
        return false;
      }
    });
    expect(warnCalls).toHaveLength(4);

    stderrSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Applied-migrations ledger (#2632)
// ─────────────────────────────────────────────────────────────────────────────

describe("migrate() — applied-migrations ledger (#2632)", () => {
  it("creates the _migrations ledger table on every call", async () => {
    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(
      queries.some((q) => q.includes("CREATE TABLE IF NOT EXISTS _migrations")),
    ).toBe(true);
  });

  it("fresh database (no pre-existing tables): runs every migration file and records each one", async () => {
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0002_b.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "ALTER TABLE t ADD COLUMN a String;";
      if (path.endsWith("0002_b.sql"))
        return "ALTER TABLE t ADD COLUMN b String;";
      return SCHEMA_SQL;
    });
    // chQueryMock's default (system.tables → 0, ledger → []) already models
    // a genuinely fresh database.

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("ADD COLUMN a"))).toBe(true);
    expect(queries.some((q) => q.includes("ADD COLUMN b"))).toBe(true);

    const recorded = chInsertMock.mock.calls
      .filter((c) => (c[0] as { table: string }).table === "_migrations")
      .flatMap(
        (c) => (c[0] as { values: readonly { filename: string }[] }).values,
      )
      .map((v) => v.filename);
    expect(recorded).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("existing deployment (pre-existing tables, empty ledger): bootstraps pre-cutover files WITHOUT executing them", async () => {
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0002_b.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "DROP TABLE IF EXISTS doomed; ALTER TABLE t ADD COLUMN a String;";
      if (path.endsWith("0002_b.sql"))
        return "ALTER TABLE t ADD COLUMN b String;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables")) return jsonResult([{ c: "5" }]); // pre-existing tables
      return jsonResult([]); // empty ledger — first time this database sees it
    });

    await migrate();

    // Neither pre-cutover file's SQL was ever sent — the bootstrap recorded
    // them as already-applied instead of replaying them (this is what stops
    // the DROP from replaying on the deploy that ships the ledger).
    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("doomed"))).toBe(false);
    expect(queries.some((q) => q.includes("ADD COLUMN a"))).toBe(false);
    expect(queries.some((q) => q.includes("ADD COLUMN b"))).toBe(false);

    const recorded = chInsertMock.mock.calls
      .filter((c) => (c[0] as { table: string }).table === "_migrations")
      .flatMap(
        (c) => (c[0] as { values: readonly { filename: string }[] }).values,
      )
      .map((v) => v.filename);
    expect(recorded).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("says out loud which files the baseline records without executing, and which still run", async () => {
    // The baseline filter is the single place that decides a file will be
    // recorded and not run. #3192 r4036723001 arrived through a filename the
    // ordinal guard accepted; a guard refuses the inputs we have thought of,
    // and this line covers the ones we have not — the decision is in the
    // deploy log either way, with both halves of it named.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0027_new_thing.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0027_new_thing.sql"))
        return "ALTER TABLE t ADD COLUMN brand_new String;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables")) return jsonResult([{ c: "5" }]);
      return jsonResult([]);
    });

    await migrate();

    const lines = stdoutSpy.mock.calls
      .map((c) => String(c[0]).trim())
      .filter((l) => l.startsWith("{"))
      .map(
        (l) =>
          JSON.parse(l) as {
            msg: string;
            cutover?: string;
            recordedWithoutExecuting?: string[];
            willExecute?: string[];
          },
      );
    stdoutSpy.mockRestore();

    const announced = lines.find((l) =>
      l.msg.includes("WITHOUT executing them"),
    );
    expect(announced).toBeDefined();
    expect(announced!.cutover).toBe("0026_stella_operational_events.sql");
    expect(announced!.recordedWithoutExecuting).toEqual(["0001_a.sql"]);
    expect(announced!.willExecute).toEqual(["0027_new_thing.sql"]);
  });

  it("says nothing about a baseline on a run that does not bootstrap one", async () => {
    // The mirror: an empty database runs every file, so there is no
    // record-without-execute decision to announce and the line must not
    // appear. A notice that fires on every run is one nobody reads.
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    readFileSyncMock.mockImplementation(() => SCHEMA_SQL);
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables")) return jsonResult([{ c: "0" }]);
      return jsonResult([]);
    });

    await migrate();

    const announced = stdoutSpy.mock.calls
      .map((c) => String(c[0]))
      .some((l) => l.includes("WITHOUT executing them"));
    stdoutSpy.mockRestore();
    expect(announced).toBe(false);
  });

  it("a filename sorting AFTER the pre-ledger cutover still executes for real on an existing deployment's bootstrap run", async () => {
    // 0027 sorts after PRE_LEDGER_BASELINE_CUTOVER
    // ("0026_stella_operational_events.sql") — a migration that did not
    // exist when the cutover was pinned must never be swept into the
    // baseline, even on the very deploy that introduces the ledger.
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0027_new_thing.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0027_new_thing.sql"))
        return "ALTER TABLE t ADD COLUMN brand_new String;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables")) return jsonResult([{ c: "5" }]);
      return jsonResult([]);
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("ADD COLUMN brand_new"))).toBe(true);

    const recorded = chInsertMock.mock.calls
      .filter((c) => (c[0] as { table: string }).table === "_migrations")
      .flatMap(
        (c) => (c[0] as { values: readonly { filename: string }[] }).values,
      )
      .map((v) => v.filename);
    // 0001_a.sql was bootstrapped (recorded without executing); 0027 was
    // recorded only after its statement actually ran.
    expect(recorded).toContain("0001_a.sql");
    expect(recorded).toContain("0027_new_thing.sql");
  });

  it("a FRESH-origin ledger that is empty runs every migration (#2972)", async () => {
    // Run 1 on an empty database created _migrations — stamped "fresh" — then
    // died inside schema.sql. Run 2 sees tables and an empty ledger. Before the
    // origin existed that shape was read as a pre-ledger deployment and every
    // pre-cutover file was recorded as applied WITHOUT running, leaving
    // error_events and friends absent forever. The stamp settles it.
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0002_b.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "CREATE TABLE IF NOT EXISTS needed_a (id UInt32) ENGINE=MergeTree() ORDER BY id;";
      if (path.endsWith("0002_b.sql"))
        return "CREATE TABLE IF NOT EXISTS needed_b (id UInt32) ENGINE=MergeTree() ORDER BY id;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([
          { ledger: "1", c: "3", ledger_comment: ORIGIN_FRESH },
        ]);
      return jsonResult([]);
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("needed_a"))).toBe(true);
    expect(queries.some((q) => q.includes("needed_b"))).toBe(true);
    expect(recordedFilenames()).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("a PRE-LEDGER-origin ledger that is empty bootstraps instead of replaying (#3192 r4035933342)", async () => {
    // The mirror, and the one Codex caught. An EXISTING pre-ledger deployment's
    // first ledger-aware run created _migrations and died inside schema.sql, so
    // the ledger is empty although every pre-cutover file has already been
    // applied many times. Reading the empty ledger as authoritative replays
    // them — and 0021 drops and recreates schema_conformance_events, destroying
    // retained data. The origin stamp is what stops that.
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0002_b.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "DROP TABLE IF EXISTS schema_conformance_events; CREATE TABLE IF NOT EXISTS schema_conformance_events (id UInt32) ENGINE=MergeTree() ORDER BY id;";
      if (path.endsWith("0002_b.sql"))
        return "ALTER TABLE t ADD COLUMN b String;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([
          { ledger: "1", c: "12", ledger_comment: ORIGIN_PRE_LEDGER },
        ]);
      return jsonResult([]); // empty: run 1 died before recording the backlog
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    // The DROP never reached the server. This is the assertion the review is
    // about: retained data survives the retry.
    expect(
      queries.some((q) =>
        q.includes("DROP TABLE IF EXISTS schema_conformance_events"),
      ),
    ).toBe(false);
    expect(queries.some((q) => q.includes("ADD COLUMN b"))).toBe(false);
    // Both pre-cutover files were recorded as applied without executing.
    expect(recordedFilenames()).toEqual(["0001_a.sql", "0002_b.sql"]);
  });

  it("writes the origin onto a legacy ledger BEFORE schema.sql can fail (#3192 r4036387110)", async () => {
    // Without this, CREATE TABLE IF NOT EXISTS leaves the legacy comment blank
    // — the same property that protects a recorded origin — so the ledger never
    // acquires one, and the next crash inside schema.sql turns a database we
    // can decide today into one we must refuse tomorrow.
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "1", c: "0", ledger_comment: "" }]);
      return jsonResult([]);
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    const stampAt = queries.findIndex((q) =>
      q.includes(`MODIFY COMMENT '${ORIGIN_FRESH}'`),
    );
    // schema.sql's OWN statement, not the ledger CREATE that precedes it — a
    // looser matcher here finds `CREATE TABLE IF NOT EXISTS _migrations` at
    // index 0 and the assertion passes or fails for the wrong reason.
    const schemaAt = queries.findIndex((q) => q.includes("EXISTS t ("));
    expect(stampAt).toBeGreaterThanOrEqual(0);
    // Ordering is the whole point: a stamp written after schema.sql would not
    // survive the failure it exists to protect against.
    expect(stampAt).toBeLessThan(schemaAt);
  });

  it("continues when the origin stamp cannot be written", async () => {
    // The stamp narrows a FUTURE ambiguity; this run is already decided
    // correctly without it. Failing the migration over a comment would turn a
    // working deployment into a broken one.
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) =>
      String(p).endsWith("0001_a.sql")
        ? "ALTER TABLE t ADD COLUMN a String;"
        : SCHEMA_SQL,
    );
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "1", c: "0", ledger_comment: "" }]);
      return jsonResult([]);
    });
    chCommandMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("MODIFY COMMENT"))
        throw new Error("MODIFY COMMENT unsupported");
    });

    await expect(migrate()).resolves.toBeUndefined();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("ADD COLUMN a"))).toBe(true);
  });

  it("refuses rather than guess when a pre-comment ledger is empty and tables exist", async () => {
    // The one undecidable state, and the only one that can still occur: a
    // ledger created before the origin stamp, holding nothing, in a database
    // that has tables. The two histories above both produce it and they want
    // opposite treatment, so this stops instead of picking.
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "DROP TABLE IF EXISTS schema_conformance_events;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "1", c: "9", ledger_comment: "" }]);
      return jsonResult([]);
    });

    await expect(migrate()).rejects.toThrow(AmbiguousLedgerOriginError);

    // Nothing was applied and nothing was recorded — refusing is inert, which
    // is the point of refusing.
    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("schema_conformance_events"))).toBe(
      false,
    );
    expect(chInsertMock).not.toHaveBeenCalled();
  });

  it("stamps a new ledger with the origin it can only observe right now", async () => {
    // The CREATE carries the answer, so there is no window between "table
    // exists" and "origin known" for a crash to fall into.
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "0", c: "7", ledger_comment: "" }]);
      return jsonResult([]);
    });

    await migrate();

    const create = chCommandMock.mock.calls
      .map((c) => (c[0] as { query: string }).query)
      .find((q) => q.includes("CREATE TABLE IF NOT EXISTS _migrations"));
    expect(create).toContain(`COMMENT '${ORIGIN_PRE_LEDGER}'`);
  });

  it("a pre-ledger deployment (tables, and NO ledger table) still bootstraps", async () => {
    // The other side of the same fork: this is the shape the bootstrap exists
    // for, and the #2972 change must not take it away. Distinguished from the
    // case above by `ledger: "0"` alone.
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql")) return "DROP TABLE IF EXISTS doomed;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "0", c: "12" }]);
      return jsonResult([]);
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("doomed"))).toBe(false);

    const recorded = chInsertMock.mock.calls
      .filter((c) => (c[0] as { table: string }).table === "_migrations")
      .flatMap(
        (c) => (c[0] as { values: readonly { filename: string }[] }).values,
      )
      .map((v) => v.filename);
    expect(recorded).toEqual(["0001_a.sql"]);
  });

  it("counts the ledger table separately from everything else", async () => {
    // A database holding ONLY _migrations (created by a run that failed before
    // schema.sql) is not "a database with pre-existing tables". The old query
    // counted it as one.
    readdirSyncMock.mockReturnValue(["0001_a.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "CREATE TABLE IF NOT EXISTS needed_a (id UInt32) ENGINE=MergeTree() ORDER BY id;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables"))
        return jsonResult([{ ledger: "1", c: "0", ledger_comment: "" }]);
      return jsonResult([]);
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    expect(queries.some((q) => q.includes("needed_a"))).toBe(true);
    // And the query it asked is the one that can tell them apart at all.
    const inspect = chQueryMock.mock.calls
      .map((c) => (c[0] as { query: string }).query)
      .find((q) => q.includes("system.tables"));
    expect(inspect).toContain("countIf(name = '_migrations')");
    expect(inspect).toContain("countIf(name != '_migrations')");
    expect(inspect).toContain("anyIf(comment, name = '_migrations')");
  });

  it("skips a file already recorded in the ledger and only executes the unrecorded one", async () => {
    readdirSyncMock.mockReturnValue(["0001_a.sql", "0002_b.sql"]);
    readFileSyncMock.mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("0001_a.sql"))
        return "DROP TABLE IF EXISTS already_done; ALTER TABLE t ADD COLUMN a String;";
      if (path.endsWith("0002_b.sql"))
        return "ALTER TABLE t ADD COLUMN b String;";
      return SCHEMA_SQL;
    });
    chQueryMock.mockImplementation(async (opts: { query: string }) => {
      if (opts.query.includes("system.tables")) return jsonResult([{ c: "5" }]);
      return jsonResult([{ filename: "0001_a.sql" }]); // already applied
    });

    await migrate();

    const queries = chCommandMock.mock.calls.map(
      (c) => (c[0] as { query: string }).query,
    );
    // 0001_a's DROP never replayed — this is the bug, fixed: a file already
    // in the ledger is never re-sent to the server.
    expect(queries.some((q) => q.includes("already_done"))).toBe(false);
    expect(queries.some((q) => q.includes("ADD COLUMN a"))).toBe(false);
    expect(queries.some((q) => q.includes("ADD COLUMN b"))).toBe(true);

    const recorded = chInsertMock.mock.calls
      .filter((c) => (c[0] as { table: string }).table === "_migrations")
      .flatMap(
        (c) => (c[0] as { values: readonly { filename: string }[] }).values,
      )
      .map((v) => v.filename);
    expect(recorded).toEqual(["0002_b.sql"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// isDirectRun top-level block
//
// The block `if (isDirectRun) { migrate().then(...) }` runs synchronously at
// module load time. We exercise it by resetting the module registry, setting
// process.argv[1] to match migrate.ts's import.meta.url, then re-importing.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// decideLedgerAction — the whole state space
//
// The bootstrap decision has exactly four observable inputs and eight reachable
// states. Enumerating them here rather than only through migrate() is the point:
// the defect this function exists for was never a wrong line of code, it was a
// state nobody had written down, twice in a row and in opposite directions.
// ─────────────────────────────────────────────────────────────────────────────

describe("decideLedgerAction", () => {
  const facts = (o: Partial<Parameters<typeof decideLedgerAction>[0]>) =>
    decideLedgerAction({
      hasLedgerTable: false,
      hasOtherTables: false,
      ledgerComment: "",
      appliedCount: 0,
      ...o,
    });

  describe("no ledger yet — the last moment the database says what it is", () => {
    it("tables and no ledger is a pre-ledger deployment", () => {
      expect(facts({ hasOtherTables: true }).action).toBe("bootstrap");
    });

    it("nothing at all is a new database", () => {
      expect(facts({}).action).toBe("proceed");
    });
  });

  describe("the ledger records its own origin", () => {
    it("pre-ledger origin with an empty ledger bootstraps — it does NOT replay", () => {
      // #3192 r4035933342. Replaying here runs 0021's DROP against a table
      // holding real data.
      expect(
        facts({
          hasLedgerTable: true,
          hasOtherTables: true,
          ledgerComment: ORIGIN_PRE_LEDGER,
          appliedCount: 0,
        }).action,
      ).toBe("bootstrap");
    });

    it("pre-ledger origin with a recorded backlog just proceeds", () => {
      expect(
        facts({
          hasLedgerTable: true,
          hasOtherTables: true,
          ledgerComment: ORIGIN_PRE_LEDGER,
          appliedCount: 26,
        }).action,
      ).toBe("proceed");
    });

    it("fresh origin never bootstraps, empty ledger or not", () => {
      // The first defect, from the other side: sweeping a backlog into a
      // database that never had one leaves its tables absent forever.
      for (const appliedCount of [0, 2]) {
        expect(
          facts({
            hasLedgerTable: true,
            hasOtherTables: true,
            ledgerComment: ORIGIN_FRESH,
            appliedCount,
          }).action,
        ).toBe("proceed");
      }
    });

    it("does not read an origin it does not recognise as either one", () => {
      // A comment set by something else must not be taken for a stamp.
      expect(
        facts({
          hasLedgerTable: true,
          hasOtherTables: true,
          ledgerComment: "some unrelated table comment",
          appliedCount: 0,
        }).action,
      ).toBe("refuse");
    });
  });

  describe("a ledger created before the origin stamp existed", () => {
    it("proceeds when it has applied things — its rows are the truth", () => {
      // Every deployment already on the ledger is this state. It must not
      // suddenly start refusing, and it must not bootstrap a backlog it has
      // already accounted for.
      expect(
        facts({
          hasLedgerTable: true,
          hasOtherTables: true,
          appliedCount: 27,
        }).action,
      ).toBe("proceed");
    });

    it("refuses when it is empty and the database has tables", () => {
      const d = facts({
        hasLedgerTable: true,
        hasOtherTables: true,
        appliedCount: 0,
      });
      expect(d.action).toBe("refuse");
      expect(d.reason).toContain("pre-comment ledger");
    });

    it("proceeds when it is empty and the database is otherwise empty", () => {
      // Both histories agree here: nothing has ever succeeded, so everything
      // must run. Refusing would strand a database that is not ambiguous.
      expect(
        facts({
          hasLedgerTable: true,
          hasOtherTables: false,
          appliedCount: 0,
        }).action,
      ).toBe("proceed");
    });
  });

  describe("transitions into the design, not only its resting states", () => {
    // #3192 r4036387110 and r4036387103. The design is safe once every ledger
    // carries an origin. Getting there is its own state machine, taken once per
    // database, by someone who cannot retry it cleanly.

    it("stamps a legacy ledger while its origin is still knowable", () => {
      // Empty, commentless, nothing else in the database: nothing has ever
      // succeeded, so "fresh" is the only history that fits. Writing it now is
      // what stops a crash inside schema.sql making this database undecidable.
      const d = facts({
        hasLedgerTable: true,
        hasOtherTables: false,
        ledgerComment: "",
        appliedCount: 0,
      });
      expect(d.action).toBe("proceed");
      expect(d.backfillOrigin).toBe(ORIGIN_FRESH);
    });

    it("does not invent an origin for a legacy ledger that is in use", () => {
      // Its origin is unknowable AND irrelevant: rows keep it decidable for
      // ever. Stamping a guess here would be worse than leaving it blank.
      const d = facts({
        hasLedgerTable: true,
        hasOtherTables: true,
        ledgerComment: "",
        appliedCount: 27,
      });
      expect(d.action).toBe("proceed");
      expect(d.backfillOrigin).toBeNull();
    });

    it("does not stamp the state it refuses", () => {
      // The residue is undecidable, so there is nothing truthful to write.
      const d = facts({
        hasLedgerTable: true,
        hasOtherTables: true,
        ledgerComment: "",
        appliedCount: 0,
      });
      expect(d.action).toBe("refuse");
      expect(d.backfillOrigin).toBeNull();
    });

    it("never backfills a ledger this run is about to create", () => {
      // The CREATE stamps it; a second write would be redundant and could
      // disagree with it.
      for (const hasOtherTables of [true, false]) {
        expect(
          facts({ hasLedgerTable: false, hasOtherTables }).backfillOrigin,
        ).toBeNull();
      }
    });

    it("never backfills over an origin that is already recorded", () => {
      for (const ledgerComment of [ORIGIN_FRESH, ORIGIN_PRE_LEDGER]) {
        for (const appliedCount of [0, 27]) {
          expect(
            facts({ hasLedgerTable: true, ledgerComment, appliedCount })
              .backfillOrigin,
          ).toBeNull();
        }
      }
    });
  });

  it("never refuses a state that a ledger written by this version can reach", () => {
    // The test the fix has to pass: with an origin present, no combination of
    // the other three facts is undecidable. If this ever fails, the ambiguous
    // state has come back.
    for (const ledgerComment of [ORIGIN_PRE_LEDGER, ORIGIN_FRESH]) {
      for (const hasOtherTables of [true, false]) {
        for (const appliedCount of [0, 1, 27]) {
          expect(
            facts({
              hasLedgerTable: true,
              ledgerComment,
              hasOtherTables,
              appliedCount,
            }).action,
          ).not.toBe("refuse");
        }
      }
    }
  });
});

describe("isDirectRun block", () => {
  // Path of migrate.ts resolved relative to THIS test file (same directory).
  const migrateFilePath = fileURLToPath(
    new URL("./migrate.ts", import.meta.url),
  );

  it("calls migrate(), then closeClickhouse(), then writes success JSON to stdout and exits 0", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: string | number | null) => undefined as never,
      );
    const savedArgv1 = process.argv[1] as string;

    try {
      vi.resetModules();
      commandMock.mockResolvedValue(undefined);
      chCommandMock.mockResolvedValue(undefined);
      closeClickhouseMock.mockResolvedValue(undefined);

      process.argv[1] = migrateFilePath;
      await import("./migrate");

      // Wait for the `.then()` chain to settle. migrate() now awaits several
      // ledger round-trips (table-count check, ledger select, per-file
      // insert) before resolving, so a fixed microtask-flush count is no
      // longer reliable — poll instead.
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalled();
      });

      expect(closeClickhouseMock).toHaveBeenCalledTimes(1);

      const written = stdoutSpy.mock.calls.find((c) =>
        String(c[0]).includes("migration complete"),
      );
      expect(written).toBeDefined();
      const parsed = JSON.parse(String(written![0]!).trim()) as {
        level: string;
        msg: string;
      };
      expect(parsed.level).toBe("info");
      expect(parsed.msg).toContain("migration complete");

      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      process.argv[1] = savedArgv1;
      stdoutSpy.mockRestore();
      exitSpy.mockRestore();
      vi.resetModules();
    }
  });

  it("writes error JSON to stderr and exits 1 when migrate() rejects", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: string | number | null) => undefined as never,
      );
    const savedArgv1 = process.argv[1] as string;

    try {
      vi.resetModules();
      // Make the schema-application step fail (after ensureDatabase succeeds)
      commandMock.mockResolvedValue(undefined); // ensureDatabase succeeds
      chCommandMock.mockRejectedValue(new Error("schema apply failed")); // migrate() fails

      process.argv[1] = migrateFilePath;
      await import("./migrate");

      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalled();
      });

      const errorCall = stderrSpy.mock.calls.find((c) =>
        String(c[0]).includes("migration failed"),
      );
      expect(errorCall).toBeDefined();
      const parsed = JSON.parse(String(errorCall![0]!).trim()) as {
        level: string;
        msg: string;
        err: string;
      };
      expect(parsed.level).toBe("error");
      expect(parsed.msg).toContain("migration failed");
      expect(typeof parsed.err).toBe("string");

      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      process.argv[1] = savedArgv1;
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      vi.resetModules();
    }
  });

  it("does NOT execute the block when process.argv[1] differs from the module path", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        (_code?: string | number | null) => undefined as never,
      );
    const savedArgv1 = process.argv[1] as string;

    try {
      vi.resetModules();
      commandMock.mockResolvedValue(undefined);
      chCommandMock.mockResolvedValue(undefined);

      // Point argv[1] at a different file
      process.argv[1] = "/some/other/script.js";
      await import("./migrate");

      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      // No migration ran → clickhouse singleton never called
      expect(chCommandMock).not.toHaveBeenCalled();
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.argv[1] = savedArgv1;
      exitSpy.mockRestore();
      vi.resetModules();
    }
  });
});
