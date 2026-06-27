import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "neo4j-driver";
import { closeDriver, session } from "./client";

// Each Cypher statement runs in its own transaction so a single bad DDL
// doesn't roll back the whole schema.
function splitStatements(source: string): string[] {
  return source
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .split(/;\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Neo4j returns counts as Integer objects (lossless) by default; normalize the
// handful of shapes we can receive (Integer | bigint | number) to a JS number.
function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (
    value !== null &&
    typeof value === "object" &&
    "toNumber" in value &&
    typeof (value as { toNumber: unknown }).toNumber === "function"
  ) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value ?? 0);
}

/**
 * Collapse duplicate-publicId legacy :KnowledgeNode nodes BEFORE the one-time
 * :KnowledgeNode -> :GraphNode relabel in schema.cypher promotes them.
 *
 * Why this is needed: the legacy :KnowledgeNode label never carried a uniqueness
 * constraint on publicId, so dev and preview graphs can accumulate several nodes
 * that share one publicId (classically, a demo subgraph seeded more than once).
 * The relabel folds every :KnowledgeNode into :GraphNode, whose
 * graph_node_public_id constraint forbids duplicate publicIds — so on any such
 * graph the relabel hard-fails ("Node already exists with label `GraphNode` and
 * property `publicId`"), atomically rolls back, and wedges `pnpm db:migrate`.
 *
 * apoc.refactor.mergeNodes folds each duplicate set into a single survivor,
 * rewiring relationships onto it (no data loss) and de-duping the now-identical
 * edges via mergeRels. After this runs, every legacy publicId is unique, so the
 * relabel promotes cleanly.
 *
 * Guarded so the APOC procedure is only ever sent to Neo4j when duplicates
 * actually exist: clean graphs (fresh CI service containers, rebuilt prod)
 * short-circuit on the pure-Cypher count below, so a community Neo4j without the
 * APOC plugin is never asked to plan an apoc.* call (Neo4j validates procedure
 * names at plan time, even for zero-row statements). Every environment that can
 * hold legacy duplicates — local dev and preview Aura — ships APOC.
 */
export async function dedupeLegacyKnowledgeNodes(s: Session): Promise<void> {
  const dupCheck = await s.run(
    `MATCH (n:KnowledgeNode)
     WHERE NOT n:GraphNode AND n.publicId IS NOT NULL
     WITH n.publicId AS pid, count(*) AS c
     WHERE c > 1
     RETURN count(pid) AS groups, sum(c - 1) AS removable`,
  );

  const groups = toNumber(dupCheck.records[0]?.get("groups"));
  if (groups === 0) return;

  const removable = toNumber(dupCheck.records[0]?.get("removable"));
  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "Neo4j migrate: collapsing duplicate-publicId legacy KnowledgeNode nodes before relabel",
      groups,
      removed: removable,
    }) + "\n",
  );

  try {
    await s.run(
      `MATCH (n:KnowledgeNode)
       WHERE NOT n:GraphNode AND n.publicId IS NOT NULL
       WITH n.publicId AS pid, collect(n) AS nodes
       WHERE size(nodes) > 1
       CALL apoc.refactor.mergeNodes(nodes, {properties: 'discard', mergeRels: true})
       YIELD node
       RETURN count(node) AS merged`,
    );
  } catch (err) {
    throw new Error(
      `Neo4j migrate: failed to collapse ${groups} duplicate-publicId legacy :KnowledgeNode ` +
        `group(s) before the :GraphNode relabel. This requires the APOC plugin ` +
        `(apoc.refactor.mergeNodes). Enable APOC on this Neo4j instance, or manually dedupe the ` +
        `offending publicIds, then re-run db:migrate. Underlying error: ${String(err)}`,
    );
  }
}

export async function migrate(): Promise<void> {
  const here = dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(join(here, "schema.cypher"), "utf8");
  const statements = splitStatements(source);

  const s = session();
  try {
    // Resolve duplicate legacy publicIds first, so the schema.cypher relabel can
    // promote :KnowledgeNode -> :GraphNode without hitting the uniqueness
    // constraint. No-op on clean graphs. See dedupeLegacyKnowledgeNodes.
    await dedupeLegacyKnowledgeNodes(s);
    for (const stmt of statements) {
      await s.run(stmt);
    }
  } finally {
    await s.close();
  }
}

const isDirectRun = import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  migrate()
    .then(() => closeDriver())
    .then(() => {
      process.stdout.write(JSON.stringify({ level: "info", msg: "Neo4j migration complete" }) + "\n");
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({ level: "error", msg: "Neo4j migration failed", err: String(err) }) + "\n",
      );
      process.exit(1);
    });
}
