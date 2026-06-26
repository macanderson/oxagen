/**
 * Store factory — creates the appropriate episodic store adapter based on
 * environment configuration.
 *
 * - Local/dev/test: DuckDB (file-backed or in-memory)
 * - Cloud/production: ClickHouse
 */
import type { EpisodicStore } from "./episodic";
import { DuckDBEpisodicStore } from "./duckdb-adapter";
import { ClickHouseEpisodicStore } from "./clickhouse-adapter";

export type { EpisodicStore, EpisodicQuery } from "./episodic";
export { DuckDBEpisodicStore } from "./duckdb-adapter";
export { ClickHouseEpisodicStore } from "./clickhouse-adapter";

export interface StoreConfig {
  /** "duckdb" or "clickhouse". Defaults to env-based detection. */
  adapter?: "duckdb" | "clickhouse";
  /** DuckDB file path. Defaults to `:memory:`. */
  duckdbPath?: string;
  /** ClickHouse connection options (required if adapter is "clickhouse"). */
  clickhouse?: {
    url: string;
    username: string;
    password: string;
    database: string;
  };
}

/**
 * Create an episodic store based on configuration or environment.
 *
 * Detection order:
 * 1. Explicit `adapter` in config
 * 2. Presence of `CLICKHOUSE_URL` env var → ClickHouse
 * 3. Otherwise → DuckDB (in-memory for tests, file for dev)
 */
export function createStore(config: StoreConfig = {}): EpisodicStore {
  const adapter = config.adapter ?? detectAdapter();

  if (adapter === "clickhouse") {
    const ch = config.clickhouse ?? {
      url: process.env["CLICKHOUSE_URL"] ?? "",
      username: process.env["CLICKHOUSE_USERNAME"] ?? "",
      password: process.env["CLICKHOUSE_PASSWORD"] ?? "",
      database: process.env["CLICKHOUSE_DATABASE"] ?? "default",
    };
    if (!ch.url) {
      throw new Error(
        "ClickHouse adapter selected but CLICKHOUSE_URL is not configured",
      );
    }
    return new ClickHouseEpisodicStore(ch);
  }

  // DuckDB adapter
  const path = config.duckdbPath ?? ":memory:";
  return new DuckDBEpisodicStore({ path });
}

function detectAdapter(): "duckdb" | "clickhouse" {
  if (process.env["CLICKHOUSE_URL"]) return "clickhouse";
  return "duckdb";
}
