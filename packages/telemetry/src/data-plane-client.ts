/**
 * Per-organisation ClickHouse clients for DEDICATED data planes (ADR-042 §2).
 *
 * The shared plane keeps one process-wide client (`clickhouse()` in
 * clickhouse.ts). A dedicated plane needs its own: a customer-controlled
 * endpoint, its own credential, and a network the platform's client cannot
 * reach. Cache key = `${orgId}:${configDigest}`, LRU-bounded and closed on
 * eviction — a rotated credential produces a new digest, so the stale client is
 * closed rather than retried against a revoked password.
 *
 * The `date_time_input_format: "best_effort"` setting is applied here too: every
 * caller stamps timestamps with `new Date().toISOString()`, and ClickHouse's
 * default `basic` parser rejects the ISO `T`/`Z` form against DateTime64. A
 * dedicated plane that omitted it would fail every insert with a parse error the
 * shared plane never sees.
 */
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import type { ClickHousePlaneConfig } from "@oxagen/tenancy";

/** Maximum simultaneously-open dedicated ClickHouse clients per process. */
export const MAX_DEDICATED_CLICKHOUSE_CLIENTS = 16;

const clients = new Map<string, ClickHouseClient>();

function cacheKey(orgId: string, configDigest: string | null | undefined) {
  return `${orgId}:${configDigest ?? "nodigest"}`;
}

function closeClient(client: ClickHouseClient): void {
  // Fire-and-forget: a client whose host has gone away must not stall the
  // request that evicted it, and a discarded client has nothing actionable
  // left to report.
  void client.close().catch(() => undefined);
}

/** Get (or open) one organisation's dedicated ClickHouse client. */
export function dedicatedClickhouse(args: {
  orgId: string;
  config: ClickHousePlaneConfig;
  configDigest?: string | null;
}): ClickHouseClient {
  const key = cacheKey(args.orgId, args.configDigest);
  const hit = clients.get(key);
  if (hit) {
    // LRU touch.
    clients.delete(key);
    clients.set(key, hit);
    return hit;
  }

  // Drop any client bound to a superseded digest for the same organisation.
  evictOrgClickhouse(args.orgId);

  if (clients.size >= MAX_DEDICATED_CLICKHOUSE_CLIENTS) {
    const oldestKey = clients.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = clients.get(oldestKey);
      clients.delete(oldestKey);
      if (oldest) closeClient(oldest);
    }
  }

  const client = createClient({
    url: args.config.url,
    username: args.config.username,
    password: args.config.password,
    database: args.config.database,
    clickhouse_settings: { date_time_input_format: "best_effort" },
  });
  clients.set(key, client);
  return client;
}

/** Close and forget every client for one organisation (rotation, disable). */
export function evictOrgClickhouse(orgId: string): void {
  const prefix = `${orgId}:`;
  for (const [key, client] of clients) {
    if (key.startsWith(prefix)) {
      clients.delete(key);
      closeClient(client);
    }
  }
}

/** Close and forget every dedicated client. Shutdown and test reset. */
export function closeDedicatedClickhouse(): void {
  for (const [key, client] of clients) {
    clients.delete(key);
    closeClient(client);
  }
}

/** Number of live dedicated clients. Diagnostics and tests. */
export function dedicatedClickhouseCount(): number {
  return clients.size;
}
