// migrate.test.ts — the internal bench.* ClickHouse migration runner.
// node:fs and the telemetry primitives it reuses are all mocked so no real
// filesystem or ClickHouse connection is touched.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const commandMock = vi.hoisted(() => vi.fn());
const closeClickhouseMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(undefined),
);
const splitStatementsMock = vi.hoisted(() =>
  vi.fn((sql: string) =>
    sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean),
  ),
);
const readFileSyncMock = vi.hoisted(() =>
  vi.fn(
    (_path: string) =>
      "CREATE DATABASE IF NOT EXISTS bench;\nCREATE TABLE foo (id Int32)",
  ),
);
const readdirSyncMock = vi.hoisted(() =>
  vi.fn(() => ["0001_bench_schema.sql", "README.md"]),
);

vi.mock("@oxagen/telemetry", () => ({
  closeClickhouse: closeClickhouseMock,
  // `migrate.ts` calls this at module load to decide whether it was run
  // directly; under vitest it must be a no-op guard (never the direct entry).
  isDirectRunEntry: () => false,
}));
vi.mock("@oxagen/telemetry/bench-client", () => ({
  chBenchCommand: commandMock,
}));
vi.mock("@oxagen/telemetry/migrate", () => ({
  splitStatements: splitStatementsMock,
}));
vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  readdirSync: readdirSyncMock,
}));

describe("migrateBench", () => {
  beforeEach(() => {
    commandMock.mockReset().mockResolvedValue(undefined);
    readFileSyncMock.mockClear();
    readdirSyncMock.mockClear();
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("reads only .sql files from the migrations dir, in sorted order", async () => {
    const { migrateBench } = await import("./migrate");
    await migrateBench();
    expect(readdirSyncMock).toHaveBeenCalledTimes(1);
    // README.md is filtered out — readFileSync is only called for the one .sql file.
    expect(readFileSyncMock).toHaveBeenCalledTimes(1);
    expect(readFileSyncMock.mock.calls[0]![0]).toMatch(
      /0001_bench_schema\.sql$/,
    );
  });

  it("splits each migration file into statements and applies every one", async () => {
    const { migrateBench } = await import("./migrate");
    await migrateBench();
    expect(commandMock).toHaveBeenCalledTimes(2);
    expect(commandMock).toHaveBeenCalledWith(
      "CREATE DATABASE IF NOT EXISTS bench",
    );
    expect(commandMock).toHaveBeenCalledWith("CREATE TABLE foo (id Int32)");
  });

  it("retries a transiently-failing statement and succeeds on a later attempt", async () => {
    vi.useFakeTimers();
    commandMock
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValue(undefined);
    const { migrateBench } = await import("./migrate");
    const donePromise = migrateBench();
    await vi.runAllTimersAsync();
    await expect(donePromise).resolves.toBeUndefined();
    // 2 statements total; the first statement took 2 attempts (1 failure + 1 success).
    expect(commandMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("throws after exhausting all retry attempts on a permanently-failing statement", async () => {
    vi.useFakeTimers();
    commandMock.mockRejectedValue(new Error("permanent failure"));
    const { migrateBench } = await import("./migrate");
    const donePromise = migrateBench();
    // Attach the rejection assertion before advancing timers so the rejection
    // is observed rather than becoming an unhandled rejection.
    const assertion = expect(donePromise).rejects.toThrow("permanent failure");
    await vi.runAllTimersAsync();
    await assertion;
    vi.useRealTimers();
  });
});
