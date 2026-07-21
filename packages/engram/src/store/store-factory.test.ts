/**
 * Store factory tests — verifies the local DuckDB-only boundary.
 */
import { describe, it, expect } from "vitest";
import { createStore } from "./index";
import { DuckDBEpisodicStore } from "./duckdb-adapter";

describe("createStore", () => {
  it("defaults to DuckDB", () => {
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
});
