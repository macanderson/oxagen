// Domain assignment for stores that lack a first-class domain namespace.
//
// Postgres tables carry their domain natively: the pg schema name IS the domain
// (agent, billing, iam, ...), so postgres.ts assigns it directly and never
// consults this module. Blob entries are a fixed two-kind inventory that
// blob.ts pins to the `content` domain directly, so it does not consult this
// module either. ClickHouse tables and Neo4j node labels have no schema
// namespace, so their domain is assigned here by:
//   1. an explicit override map (authoritative — hand-maintained, documented), then
//   2. a name-prefix heuristic against the known pg domain set (best-effort), then
//   3. a per-store fallback domain ("telemetry" / "graph" / "content").
//
// Everything here is a pure function of static maps + the table name, so it is
// fully deterministic. When in doubt the assignment is conservative (falls back
// to the store's home domain) rather than guessing a specific business domain.

import type { StoreKind } from "./types";

/**
 * The Postgres schema domains (packages/database/src/schema/_schemas.ts).
 * Used as the target vocabulary for the name-prefix heuristic so cross-store
 * tables land in the SAME domain as their Postgres siblings where the names
 * line up (e.g. ClickHouse `eval_runs` → the `eval` domain).
 */
export const PG_DOMAINS: readonly string[] = [
  "agent",
  "ai",
  "auth",
  "billing",
  "chat",
  "cms",
  "content",
  "environments",
  "eval",
  // Immutable governed-run evidence (docs/specs/run-evidence-ingress).
  "evidence",
  "iam",
  "ingestion",
  "mcp",
  "notification",
  "org",
  "plugin",
  "privacy",
  "ratelimit",
  "schema_registry",
  "security",
  "workflow",
  "workspace",
];

/**
 * Explicit domain overrides for ClickHouse tables (schema.sql). ClickHouse is
 * the append-only telemetry store; most tables belong to the cross-cutting
 * `telemetry` domain, but several mirror a specific Postgres domain and are
 * assigned there so the domain view stitches the stores together.
 */
const CLICKHOUSE_DOMAIN_OVERRIDES: Record<string, string> = {
  execution_logs: "telemetry",
  events: "telemetry",
  token_usage: "billing", // token spend feeds the metering→billing loop
  tool_invocations: "telemetry",
  skill_loads: "agent", // skill lifecycle telemetry for agent runs
  eval_runs: "eval",
  eval_results: "eval",
  eval_item_results: "eval",
  dev_logs: "telemetry",
  sandbox_log_events: "agent", // durable code-agent sandbox command output
  router_outcomes: "billing", // verified-outcome market router cost/accuracy
};

/**
 * Explicit domain overrides for Neo4j node labels (schema.cypher). Neo4j is the
 * graph store; the neutral home domain is `graph`, but product-owned labels map
 * to the Postgres domain that owns their lifecycle.
 */
const NEO4J_DOMAIN_OVERRIDES: Record<string, string> = {
  Tenant: "org",
  Workspace: "workspace",
  User: "auth",
  Agent: "agent",
  AgentVersion: "agent",
  AgentMemory: "agent",
  Tool: "agent",
  ToolVersion: "agent",
  Skill: "agent",
  SkillVersion: "agent",
  BackgroundTask: "agent",
  Plan: "agent",
  Playbook: "workflow",
  PlaybookVersion: "workflow",
  Execution: "agent",
  Fanout: "agent",
  Document: "content",
  Conversation: "chat",
  Message: "chat",
  Citation: "agent",
  Promotion: "agent",
  Evidence: "agent",
  SourceConnection: "ingestion",
  EntityNode: "ingestion",
  GraphNode: "graph", // the universal anchor label — no single business domain
};

/** Shared empty override table for stores that declare no overrides (blob). */
const EMPTY_OVERRIDES: Record<string, string> = {};

/** Per-store fallback domain when no override or heuristic matches. */
const STORE_FALLBACK_DOMAIN: Record<Exclude<StoreKind, "postgres">, string> = {
  clickhouse: "telemetry",
  neo4j: "graph",
  blob: "content",
};

/**
 * Best-effort name-prefix heuristic: if `name` starts with a known pg domain
 * followed by `_` (e.g. "eval_runs" → "eval"), return that domain. Returns
 * undefined when no domain is a prefix. Deterministic (longest match wins so a
 * name is never ambiguously split).
 */
function heuristicDomain(name: string): string | undefined {
  const lower = name.toLowerCase();
  let best: string | undefined;
  for (const domain of PG_DOMAINS) {
    if (lower === domain || lower.startsWith(domain + "_")) {
      if (!best || domain.length > best.length) best = domain;
    }
  }
  return best;
}

/**
 * Assign a platform domain to a non-Postgres table/label/asset-kind. Override
 * map first (authoritative), then the name-prefix heuristic, then the store
 * fallback. Pure and total. Blob is accepted for completeness of the store
 * union but has no override map — blob.ts pins its two kinds directly, so this
 * path always lands on the `content` fallback.
 */
export function assignDomain(
  store: Exclude<StoreKind, "postgres">,
  name: string,
): string {
  const overrides: Record<string, string> =
    store === "clickhouse"
      ? CLICKHOUSE_DOMAIN_OVERRIDES
      : store === "neo4j"
        ? NEO4J_DOMAIN_OVERRIDES
        : EMPTY_OVERRIDES;
  return (
    overrides[name] ?? heuristicDomain(name) ?? STORE_FALLBACK_DOMAIN[store]
  );
}
