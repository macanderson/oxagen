/**
 * Store factory for Stella's local episodic memory.
 *
 * Engram is deliberately checkout-local at launch. Shared enterprise context
 * must cross Oxagen's governed, typed capability boundary; it is not selected
 * implicitly from process environment or written to a raw cloud store.
 */
import type { EpisodicStore } from "./episodic";
import { DuckDBEpisodicStore } from "./duckdb-adapter";

export type { EpisodicStore, EpisodicQuery } from "./episodic";
export { DuckDBEpisodicStore } from "./duckdb-adapter";

export interface StoreConfig {
  /** Retained for callers that select the only supported local adapter. */
  adapter?: "duckdb";
  /** DuckDB file path. Defaults to `:memory:`. */
  duckdbPath?: string;
}

/**
 * Create a local DuckDB episodic store.
 */
export function createStore(config: StoreConfig = {}): EpisodicStore {
  const path = config.duckdbPath ?? ":memory:";
  return new DuckDBEpisodicStore({ path });
}
