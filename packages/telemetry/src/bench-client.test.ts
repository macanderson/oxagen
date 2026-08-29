// Tests the unscoped bench.* primitives @oxagen/bench calls instead of
// touching the raw clickhouse() client itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const insertMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const queryMock = vi.hoisted(() => vi.fn());
const commandMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const createClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    insert: insertMock,
    query: queryMock,
    command: commandMock,
  })),
);

vi.mock("@clickhouse/client", () => ({ createClient: createClientMock }));
vi.mock("@oxagen/config/env", () => ({
  requireEnv: () => ({
    CLICKHOUSE_URL: "https://ch.example",
    CLICKHOUSE_USERNAME: "u",
    CLICKHOUSE_PASSWORD: "p",
    CLICKHOUSE_DATABASE: "oxagen",
  }),
}));

describe("chBenchInsert / chBenchQuery", () => {
  let mod: typeof import("./bench-client");

  beforeEach(async () => {
    insertMock.mockClear();
    insertMock.mockResolvedValue(undefined);
    queryMock.mockReset();
    commandMock.mockClear();
    commandMock.mockResolvedValue(undefined);
    vi.resetModules();
    mod = await import("./bench-client");
  });

  afterEach(async () => {
    const { closeClickhouse } = await import("./clickhouse");
    await closeClickhouse();
    vi.resetModules();
  });

  it("no-ops on an empty rows array", async () => {
    await mod.chBenchInsert("bench.benchmark_run", []);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("inserts rows against the fully-qualified bench.<table> name", async () => {
    const rows = [{ id: "r1", public_id: 1 }];
    await mod.chBenchInsert("bench.benchmark_run", rows);
    expect(insertMock).toHaveBeenCalledWith({
      table: "bench.benchmark_run",
      values: rows,
      format: "JSONEachRow",
    });
  });

  it("runs a query and returns the JSONEachRow rows", async () => {
    queryMock.mockResolvedValue({
      json: () => Promise.resolve([{ public_id: "1" }]),
    });
    const rows = await mod.chBenchQuery<{ public_id: string }>(
      "SELECT public_id FROM bench.benchmark_run",
      {
        limit: 10,
      },
    );
    expect(rows).toEqual([{ public_id: "1" }]);
    expect(queryMock).toHaveBeenCalledWith({
      query: "SELECT public_id FROM bench.benchmark_run",
      query_params: { limit: 10 },
      format: "JSONEachRow",
    });
  });

  it("defaults query_params to {} when omitted", async () => {
    queryMock.mockResolvedValue({ json: () => Promise.resolve([]) });
    await mod.chBenchQuery("SELECT 1");
    expect(queryMock).toHaveBeenCalledWith({
      query: "SELECT 1",
      query_params: {},
      format: "JSONEachRow",
    });
  });

  it("chBenchCommand runs a DDL/DML statement with no result set", async () => {
    await mod.chBenchCommand("CREATE DATABASE IF NOT EXISTS bench");
    expect(commandMock).toHaveBeenCalledWith({
      query: "CREATE DATABASE IF NOT EXISTS bench",
    });
  });
});
