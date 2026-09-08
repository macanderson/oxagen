/**
 * Per-organisation Neo4j drivers for DEDICATED data planes (ADR-042 §2).
 *
 * The shared plane keeps one process-wide driver (`driver()` in client.ts) —
 * Neo4j drivers own their connection pool, so one per request would trigger
 * handshake storms. A dedicated plane needs its own driver: different URI,
 * different credential, and a cluster the platform's own driver cannot reach.
 *
 * Cache key = `${orgId}:${configDigest}`, LRU-bounded and closed on eviction —
 * identical reasoning to the Postgres pool cache: a rotated credential yields a
 * new digest, so the stale driver is closed instead of retried against a
 * revoked password, and a control plane serving thousands of organisations
 * never holds thousands of live drivers per instance.
 */
import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { Neo4jPlaneConfig } from "@oxagen/tenancy";

/** Maximum simultaneously-open dedicated drivers per process. */
export const MAX_DEDICATED_DRIVERS = 16;

interface DriverEntry {
  readonly driver: Driver;
  readonly database: string;
}

const drivers = new Map<string, DriverEntry>();

function cacheKey(orgId: string, configDigest: string | null | undefined) {
  return `${orgId}:${configDigest ?? "nodigest"}`;
}

function closeEntry(entry: DriverEntry): void {
  // Fire-and-forget: a driver whose host has already gone away must not stall
  // the request that evicted it. The rejection is swallowed on purpose —
  // there is nothing actionable left to do with a driver we are discarding.
  void entry.driver.close().catch(() => undefined);
}

/**
 * Open (or reuse) a session on one organisation's dedicated Neo4j plane. The
 * caller wraps it in exactly the same scope guards as a shared-plane session —
 * a dedicated graph is not an isolation shortcut.
 */
export function dedicatedSession(args: {
  orgId: string;
  config: Neo4jPlaneConfig;
  configDigest?: string | null;
}): Session {
  const key = cacheKey(args.orgId, args.configDigest);
  const hit = drivers.get(key);
  if (hit) {
    // LRU touch.
    drivers.delete(key);
    drivers.set(key, hit);
    return hit.driver.session({ database: hit.database });
  }

  // A rotation leaves the organisation's previous digest cached under another
  // key; drop it now rather than waiting for LRU pressure.
  evictOrgDrivers(args.orgId);

  if (drivers.size >= MAX_DEDICATED_DRIVERS) {
    const oldestKey = drivers.keys().next().value;
    if (oldestKey !== undefined) {
      const oldest = drivers.get(oldestKey);
      drivers.delete(oldestKey);
      if (oldest) closeEntry(oldest);
    }
  }

  const entry: DriverEntry = {
    driver: neo4j.driver(
      args.config.uri,
      neo4j.auth.basic(args.config.username, args.config.password),
    ),
    database: args.config.database,
  };
  drivers.set(key, entry);
  return entry.driver.session({ database: entry.database });
}

/** Close and forget every driver for one organisation (rotation, disable). */
export function evictOrgDrivers(orgId: string): void {
  const prefix = `${orgId}:`;
  for (const [key, entry] of drivers) {
    if (key.startsWith(prefix)) {
      drivers.delete(key);
      closeEntry(entry);
    }
  }
}

/** Close and forget every dedicated driver. Shutdown and test reset. */
export function closeDedicatedDrivers(): void {
  for (const [key, entry] of drivers) {
    drivers.delete(key);
    closeEntry(entry);
  }
}

/** Number of live dedicated drivers. Diagnostics and tests. */
export function dedicatedDriverCount(): number {
  return drivers.size;
}
