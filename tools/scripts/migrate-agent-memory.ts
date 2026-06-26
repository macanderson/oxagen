#!/usr/bin/env tsx
/**
 * Migration script: Neo4j AgentMemory → Engram episodic records.
 *
 * Usage:
 *   tsx tools/scripts/migrate-agent-memory.ts --org=<orgId> --workspace=<workspaceId>
 *
 * Options:
 *   --org          Organization ID to migrate
 *   --workspace    Workspace ID to migrate
 *   --batch-size   Records per batch write (default: 100)
 *   --dry-run      Preview without writing (default: false)
 *   --adapter      Store adapter: "duckdb" or "clickhouse" (auto-detected)
 */
import {
  migrateMemories,
  createStore,
  type LegacyMemoryRow,
  type MigrationResult,
  type EpisodicStore,
} from "@oxagen/engram";
import neo4j, { type Record as Neo4jRecord } from "neo4j-driver";

interface CliArgs {
  org: string;
  workspace: string;
  batchSize: number;
  dryRun: boolean;
  adapter?: "duckdb" | "clickhouse";
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    const [key, value] = arg.replace(/^--/, "").split("=");
    if (key && value) parsed[key] = value;
  }

  if (!parsed["org"] || !parsed["workspace"]) {
    console.error(
      "Usage: migrate-agent-memory --org=<orgId> --workspace=<workspaceId>",
    );
    process.exit(1);
  }

  return {
    org: parsed["org"],
    workspace: parsed["workspace"],
    batchSize: Number(parsed["batch-size"]) || 100,
    dryRun: parsed["dry-run"] === "true",
    adapter: parsed["adapter"] as "duckdb" | "clickhouse" | undefined,
  };
}

/**
 * Fetch legacy memories from Neo4j for a given org/workspace.
 */
async function fetchLegacyMemories(
  orgId: string,
  workspaceId: string,
): Promise<LegacyMemoryRow[]> {
  const uri = process.env["NEO4J_URI"];
  const user = process.env["NEO4J_USERNAME"];
  const pass = process.env["NEO4J_PASSWORD"];

  if (!uri || !user || !pass) {
    throw new Error(
      "NEO4J_URI, NEO4J_USERNAME, and NEO4J_PASSWORD must be set",
    );
  }

  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
  const session = driver.session({
    database: process.env["NEO4J_DATABASE"] ?? "neo4j",
  });

  try {
    const result = await session.run(
      `MATCH (m:AgentMemory)
       WHERE m.orgId = $orgId AND m.workspaceId = $workspaceId
       RETURN m.id AS id,
              m.nodeRef AS nodeRef,
              m.weight AS weight,
              m.kind AS kind,
              m.lesson AS lesson,
              m.source AS source,
              coalesce(m.score, 0.5) AS score,
              toString(m.createdAt) AS createdAt
       ORDER BY m.createdAt ASC`,
      { orgId, workspaceId },
    );

    return result.records.map((r: Neo4jRecord) => ({
      id: r.get("id") as string,
      nodeRef: (r.get("nodeRef") as string) ?? "",
      weight: (r.get("weight") as "low" | "high" | "critical") ?? "low",
      kind: (r.get("kind") as string) ?? "observation",
      lesson: (r.get("lesson") as string) ?? "",
      source: (r.get("source") as string) ?? "",
      score: Number(r.get("score") ?? 0.5),
      createdAt: (r.get("createdAt") as string) ?? new Date().toISOString(),
      orgId,
      workspaceId,
    }));
  } finally {
    await session.close();
    await driver.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs();

  console.log(
    `[engram-migration] Starting migration for org=${args.org} workspace=${args.workspace}`,
  );
  console.log(
    `[engram-migration] Batch size: ${args.batchSize}, Dry run: ${args.dryRun}`,
  );

  // Fetch legacy memories from Neo4j
  console.log("[engram-migration] Fetching legacy memories from Neo4j...");
  const legacyRows = await fetchLegacyMemories(args.org, args.workspace);
  console.log(
    `[engram-migration] Found ${legacyRows.length} legacy memory rows`,
  );

  if (legacyRows.length === 0) {
    console.log("[engram-migration] Nothing to migrate.");
    return;
  }

  if (args.dryRun) {
    console.log("[engram-migration] Dry run — skipping store write.");
    console.log(
      `[engram-migration] Would migrate ${legacyRows.length} records.`,
    );
    return;
  }

  // Create store and run migration
  const store: EpisodicStore = createStore({ adapter: args.adapter });

  try {
    const result: MigrationResult = await migrateMemories(legacyRows, store, {
      batchSize: args.batchSize,
      onProgress: (processed: number, total: number) => {
        if (processed % 50 === 0 || processed === total) {
          console.log(`[engram-migration] Progress: ${processed}/${total}`);
        }
      },
    });

    console.log("[engram-migration] Migration complete:");
    console.log(`  Processed: ${result.processed}`);
    console.log(`  Written:   ${result.written}`);
    console.log(`  Deduped:   ${result.deduplicated}`);
    console.log(`  Errors:    ${result.errors.length}`);

    if (result.errors.length > 0) {
      console.warn("[engram-migration] Errors:");
      for (const err of result.errors.slice(0, 20)) {
        console.warn(`  ${err.legacyId}: ${err.reason}`);
      }
      if (result.errors.length > 20) {
        console.warn(`  ... and ${result.errors.length - 20} more`);
      }
    }
  } finally {
    await store.close();
  }
}

main().catch((err: unknown) => {
  console.error("[engram-migration] Fatal error:", err);
  process.exit(1);
});
