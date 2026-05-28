// Re-export of the singleton ClickHouse client. Lives in clickhouse.ts
// for historical reasons; this is the canonical import path going forward.
export { clickhouse, closeClickhouse, sumTokenUsage } from "./clickhouse.js";
export type { TokenUsageRollup } from "./clickhouse.js";
