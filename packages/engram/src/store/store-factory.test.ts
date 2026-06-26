/**
 * Store factory tests — verifies adapter selection logic and error handling.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createStore } from "./index";
import { DuckDBEpisodicStore } from "./duckdb-adapter";

describe("createStore", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Isolate env mutations
    process.env = { ...originalEnv };
    delete process.env["CLICKHOUSE_URL"];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("defaults to DuckDB when no CLICKHOUSE_URL is set", () => {
    const store = createStore();
    expect(store).toBeInstanceOf(DuckDBEpisodicStore);
  });

  it("uses DuckDB when adapter is explicitly specified", () => {
    const store = createStore({ adapter: "duckdb" });
    expect(store).toBeInstanceOf(DuckDBEpisodicStore);
  });

  it("uses DuckDB with custom path", async () => {
    const store = createStore({ adapter: "duckdb", duckdbPath: ":memory:" });
    expect(store).toBeInstanceOf(DuckDBEpisodicStore);
    await store.close();
  });

  it("throws when clickhouse adapter is selected without URL", () => {
    expect(() => createStore({ adapter: "clickhouse" })).toThrow(
      "ClickHouse adapter selected but CLICKHOUSE_URL is not configured",
    );
  });

  it("detects clickhouse from env when CLICKHOUSE_URL is set", () => {
    process.env["CLICKHOUSE_URL"] = "http://localhost:8123";
    process.env["CLICKHOUSE_USERNAME"] = "default";
    process.env["CLICKHOUSE_PASSWORD"] = "";
    process.env["CLICKHOUSE_DATABASE"] = "test";
    // This will create the ClickHouse store (connection won't work but instantiation is fine)
    const store = createStore();
    // It won't be DuckDB
    expect(store).not.toBeInstanceOf(DuckDBEpisodicStore);
  });
});
