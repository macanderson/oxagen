export { createNeo4jCodeGraphProvider } from "./code-graph";
export { createPlatformMemoryProvider } from "./memory-provider";
export type { MemoryAdapterArgs, MemoryAdapterTelemetry } from "./memory-provider";
export { createClickHouseTraceStore } from "./trace-store";
export type { TraceStoreArgs } from "./trace-store";
export { createGraphSyncAdapter, toNaturalKey } from "./graph-sync";
export type { GraphSyncAdapterArgs } from "./graph-sync";
// Postgres lease-backed file lock (ADR-021 §5) — the current provider.
export { createFileLeaseLockAdapter } from "./file-lock-lease";
export type { FileLeaseLockAdapterArgs } from "./file-lock-lease";
// @deprecated Neo4j HOLDS_LOCK-backed provider — superseded by the Postgres
// lease above (a graph lock is unsound: async sync lag hides it from a
// concurrent agent). Kept only for reference; do not wire into new call sites.
export { createFileLockAdapter } from "./file-lock";
export type { FileLockAdapterArgs } from "./file-lock";
export { createPlatformAgentAi } from "./platform-agent-ai";
