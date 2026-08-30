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
/** clickhouse() singleton factory */
const clickhouseSingletonMock = vi.hoisted(() =>
  vi.fn(() => ({ command: chCommandMock })),
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

import { migrate } from "./migrate";

// ── Shared SQL fixtures ────────────────────────────────────────────────────────

const SCHEMA_SQL =
  "CREATE TABLE IF NOT EXISTS t (id UInt32) ENGINE=MergeTree() ORDER BY id;";
const MIGRATION_SQL = "ALTER TABLE t ADD COLUMN x String;";

function defaultMocks(): void {
  commandMock.mockResolvedValue(undefined);
  bootstrapCloseMock.mockResolvedValue(undefined);
  chCommandMock.mockResolvedValue(undefined);
  closeClickhouseMock.mockResolvedValue(undefined);
  readFileSyncMock.mockReturnValue(SCHEMA_SQL);
  readdirSyncMock.mockReturnValue(["0001_init.sql"]);
  existsSyncMock.mockReturnValue(true);
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
// isDirectRun top-level block
//
// The block `if (isDirectRun) { migrate().then(...) }` runs synchronously at
// module load time. We exercise it by resetting the module registry, setting
// process.argv[1] to match migrate.ts's import.meta.url, then re-importing.
// ─────────────────────────────────────────────────────────────────────────────

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

      // Flush microtask queue so the .then() chains resolve
      await new Promise<void>((resolve) => {
        // Two awaits: one for each .then() in the chain
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => Promise.resolve())
          .then(resolve);
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

      await new Promise<void>((resolve) => {
        Promise.resolve()
          .then(() => Promise.resolve())
          .then(() => Promise.resolve())
          .then(resolve);
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
