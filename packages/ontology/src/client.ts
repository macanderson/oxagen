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

export function session(): Session {
  const env = requireEnv(["NEO4J_DATABASE"] as const);
  return driver().session({ database: env.NEO4J_DATABASE });
}

export async function closeDriver(): Promise<void> {
  if (_driver) {
    await _driver.close();
    _driver = null;
  }
}
