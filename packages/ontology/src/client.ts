import neo4j, { type Driver, type Session } from "neo4j-driver";
import { requireEnv } from "@oxagen/config/env";

// Singleton driver per process. Neo4j drivers manage their own connection
// pool — instantiating one per request triggers handshake storms against
// AuraDB.
let _driver: Driver | null = null;

export function driver(): Driver {
  if (_driver) return _driver;
  const env = requireEnv([
    "NEO4J_URI",
    "NEO4J_USERNAME",
    "NEO4J_PASSWORD",
  ] as const);
  _driver = neo4j.driver(
    env.NEO4J_URI,
    neo4j.auth.basic(env.NEO4J_USERNAME, env.NEO4J_PASSWORD),
  );
  return _driver;
}

/**
 * Open a session on the shared cluster. With no argument it opens the POOLED
 * database (`NEO4J_DATABASE`), where free and trial organisations live under
 * property scoping. An organisation provisioned into its own database
 * (spec §5.3, ADR-091) passes that name, and the engine — not a `WHERE` clause
 * — keeps every other tenant's graph out of reach.
 */
export function session(database?: string | null): Session {
  if (database) return driver().session({ database });
  const env = requireEnv(["NEO4J_DATABASE"] as const);
  return driver().session({ database: env.NEO4J_DATABASE });
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
