#!/usr/bin/env tsx
/**
 * Backfill: stamp bi-temporal validity on existing Neo4j relationships.
 *
 * Every fact-bearing edge written from now on carries validFrom/validTo (valid
 * time) and recordedAt/invalidatedAt (transaction time). Edges that predate the
 * bi-temporal rollout have none of these. Time-aware reads already treat a null
 * lower bound as "always valid / always known" (see @oxagen/ontology/temporal),
 * so this backfill is a data-consistency step, not a correctness fix — it makes
 * every historical edge explicitly valid-since-and-recorded-at its creation time.
 *
 * For each relationship missing `recordedAt` it sets:
 *   recordedAt = coalesce(r.createdAt, now)   -- when we first recorded it
 *   validFrom  = coalesce(r.validFrom, r.createdAt, now)
 * and leaves validTo / invalidatedAt absent (null ⇒ still valid / still known).
 *
 * Idempotent: the `WHERE r.recordedAt IS NULL` guard means a re-run is a no-op on
 * already-stamped edges. Batched (WITH r LIMIT $batchSize looped until empty) so
 * it never holds one giant transaction open.
 *
 * Usage:
 *   tsx tools/scripts/backfill-edge-validity.ts [--batch-size=5000] [--dry-run]
 *                                               [--rel-types=IMPLEMENTS,DEPENDS_ON]
 *
 * Options:
 *   --batch-size   Relationships stamped per transaction (default: 5000)
 *   --dry-run      Count what WOULD be stamped, write nothing (default: false)
 *   --rel-types    Comma-separated relationship types to restrict to. Omit to
 *                  stamp every relationship type.
 *
 * Env (same as every Neo4j script): NEO4J_URI, NEO4J_USERNAME, NEO4J_PASSWORD,
 * NEO4J_DATABASE (default "neo4j"). The target URI is echoed on startup.
 *
 * PROD RUN: this is a maintenance script, not a tenant-scoped capability. Run it
 * once per Neo4j instance after deploying the bi-temporal write path:
 *   1. Confirm NEO4J_URI points at the intended instance (echoed on startup).
 *   2. Dry-run first: `... --dry-run` and sanity-check the count.
 *   3. Real run: `... --batch-size=5000`. Re-runnable safely if interrupted.
 */
import neo4j, { type Driver } from "neo4j-driver";
import {
  parseRelTypes,
  runBackfill,
  validateRelTypes,
} from "./lib/backfill-edge-validity";

interface CliArgs {
  batchSize: number;
  dryRun: boolean;
  relTypes: string[] | null;
}

function parseArgs(): CliArgs {
  const parsed: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key) parsed[key] = value ?? "true";
  }
  const relTypes = parseRelTypes(parsed["rel-types"]);
  try {
    validateRelTypes(relTypes);
  } catch (err) {
    console.error(
      `[backfill-validity] ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
  return {
    batchSize: Number(parsed["batch-size"]) || 5000,
    dryRun: parsed["dry-run"] === "true",
    relTypes,
  };
}

function openDriver(): Driver {
  const uri = process.env["NEO4J_URI"];
  const user = process.env["NEO4J_USERNAME"];
  const pass = process.env["NEO4J_PASSWORD"];
  if (!uri || !user || !pass) {
    throw new Error(
      "NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD must be set",
    );
  }
  // ECHO the target so a prod run is never a surprise.
  console.log(
    `[backfill-validity] Target Neo4j: ${uri} (db=${process.env["NEO4J_DATABASE"] ?? "neo4j"})`,
  );
  return neo4j.driver(uri, neo4j.auth.basic(user, pass));
}

async function main(): Promise<void> {
  const args = parseArgs();
  const driver = openDriver();
  const session = driver.session({
    database: process.env["NEO4J_DATABASE"] ?? "neo4j",
  });

  console.log(
    `[backfill-validity] batchSize=${args.batchSize} dryRun=${args.dryRun} relTypes=${args.relTypes?.join(",") ?? "<all>"}`,
  );

  try {
    // batchSize must ride the Bolt wire as an INTEGER, so wrap it.
    const result = await runBackfill(
      {
        run: (cypher, params) =>
          session.run(cypher, {
            ...params,
            batchSize: neo4j.int(args.batchSize),
          }),
      },
      args,
      (n, total) =>
        console.log(
          `[backfill-validity] Stamped ${n} (running total ${total}).`,
        ),
    );
    console.log(
      `[backfill-validity] ${result.remainingBefore} edge(s) missing recordedAt at start.`,
    );
    if (args.dryRun) {
      console.log("[backfill-validity] Dry run — nothing written.");
    } else {
      console.log(
        `[backfill-validity] Done. Stamped ${result.stamped}; ${result.remainingAfter} remain unstamped.`,
      );
    }
  } finally {
    await session.close();
    await driver.close();
  }
}

main().catch((err) => {
  console.error("[backfill-validity] Failed:", err);
  process.exit(1);
});
