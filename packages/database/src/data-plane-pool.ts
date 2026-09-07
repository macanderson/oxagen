/**
 * Per-organisation Postgres pools for DEDICATED data planes (ADR-042 §2).
 *
 * The shared plane keeps exactly one process-wide pool (`db()` in client.ts).
 * A dedicated plane needs its own: a different host, a different credential,
 * and — the whole point — a network the platform's own pool cannot reach.
 *
 * Cache key = `${orgId}:${configDigest}`. The digest is load-bearing, not
 * decoration: on a credential rotation the resolver hands back a new digest,
 * which misses the cache, so the organisation gets a fresh pool while the
 * stale one (bound to a revoked password) is closed rather than retried into
 * an authentication-failure loop.
 *
 * Eviction is LRU with a hard ceiling. A control plane serving thousands of
 * organisations must not hold thousands of live pools per serverless instance;
 * the ceiling bounds file descriptors and the remote `max_connections` budget,
 * and the least-recently-used organisation simply reconnects on its next call.
 * Closing is fire-and-forget on the eviction path — a pool whose host has
 * already gone away must not stall the request that evicted it.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { PostgresPlaneConfig } from "@oxagen/tenancy";
import * as schema from "./schema/index";
import type { Database } from "./client";
import { logger } from "./logger";

/**
 * Maximum simultaneously-open dedicated pools per process. Deliberately small:
 * each entry is a live connection pool against a customer network, and a
 * serverless instance is short-lived, so the cost of a cache miss (one
 * connection handshake) is far below the cost of holding hundreds of idle
 * sockets open.
 */
export const MAX_DEDICATED_POOLS = 16;

/** Default per-organisation connection ceiling for a dedicated pool. */
const DEFAULT_MAX_CONNECTIONS = 5;

interface PoolEntry {
  readonly client: ReturnType<typeof postgres>;
  readonly db: Database;
}

// Map preserves insertion order, which is all an LRU needs: re-inserting on
// every hit moves the entry to the end, so the first key is the least-recently
// used one.
const pools = new Map<string, PoolEntry>();

function cacheKey(orgId: string, configDigest: string | null | undefined) {
  // A missing digest still keys per organisation — correctness first. It just
  // loses rotation-driven eviction, which the resolver never omits in practice
  // (the digest column is written on every set_data_plane).
  return `${orgId}:${configDigest ?? "nodigest"}`;
}

/** Close one pool, swallowing (but logging) a failure to drain. */
function closeEntry(key: string, entry: PoolEntry, reason: string): void {
  void entry.client.end({ timeout: 5 }).catch((err: unknown) => {
    logger.warn(
      { key, reason, err: err instanceof Error ? err.message : String(err) },
      "data-plane: dedicated pool failed to drain on close",
    );
  });
}

/**
 * Get (or open) the Drizzle client for one organisation's dedicated Postgres
 * plane. The returned handle is a normal `Database`, so `withTenantDb` sets the
 * exact same RLS GUCs on it that it sets on the shared plane — a dedicated
 * plane is not an isolation shortcut, it is a second place the same policies
 * are enforced.
 */
export function dedicatedDb(args: {
  orgId: string;
  config: PostgresPlaneConfig;
  configDigest?: string | null;
}): Database {
  const key = cacheKey(args.orgId, args.configDigest);
  const hit = pools.get(key);
  if (hit) {
    // LRU touch: delete + re-set moves this key to the end of the iteration
    // order so it is the last candidate for eviction.
    pools.delete(key);
    pools.set(key, hit);
    return hit.db;
  }

  // A rotation leaves the organisation's PREVIOUS digest cached under a
  // different key. Drop it now rather than waiting for LRU pressure: it is
  // bound to a credential that may already be revoked.
  evictOrg(args.orgId, "superseded by a new config digest");

  if (pools.size >= MAX_DEDICATED_POOLS) {
    const oldestKey = pools.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = pools.get(oldestKey);
      pools.delete(oldestKey);
      if (oldest) closeEntry(oldestKey, oldest, "lru_eviction");
    }
  }

  const client = postgres({
    host: args.config.host,
    port: args.config.port,
    database: args.config.database,
    username: args.config.username,
    password: args.config.password,
    // TLS defaults ON for a dedicated plane: the connection crosses a network
    // boundary the platform does not control, so plaintext must be opt-out and
    // explicit, never the default.
    ssl: args.config.ssl ?? true,
    max: args.config.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
    prepare: false,
  });
  const entry: PoolEntry = {
    client,
    db: drizzle(client, { schema, casing: "snake_case" }),
  };
  pools.set(key, entry);
  // Host + database only — never the credential. This line ships to log
  // aggregation.
  logger.info(
    {
      orgId: args.orgId,
      host: args.config.host,
      database: args.config.database,
      pools: pools.size,
    },
    "data-plane: opened dedicated Postgres pool",
  );
  return entry.db;
}

/**
 * Close and forget every pool for one organisation. Called on rotation and by
 * the resolver's cache invalidation, so the next access reconnects with the
 * new credential.
 */
export function evictOrg(orgId: string, reason = "invalidated"): void {
  const prefix = `${orgId}:`;
  for (const [key, entry] of pools) {
    if (key.startsWith(prefix)) {
      pools.delete(key);
      closeEntry(key, entry, reason);
    }
  }
}

/** Close and forget every dedicated pool. Process shutdown and test reset. */
export function closeDedicatedPools(): void {
  for (const [key, entry] of pools) {
    pools.delete(key);
    closeEntry(key, entry, "shutdown");
  }
}

/** Number of live dedicated pools. Diagnostics and tests. */
export function dedicatedPoolCount(): number {
  return pools.size;
}
