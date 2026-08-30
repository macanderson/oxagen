import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectRunEntry } from "@oxagen/telemetry";
import type { Session } from "neo4j-driver";
import { closeDriver, session } from "./client";
import { sanitizeLabel } from "./labels";

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
      // Pre-merge estimate: how many nodes the collapse below can remove. It is
      // logged before the merge runs, so it is not a completion count.
      removable,
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

/**
 * One-time, idempotent recasing of every domain node identifier to PascalCase —
 * both the structural Neo4j `:Label` and the `label` display property the graph
 * explorer groups/colours/filters on.
 *
 * Why this is needed: earlier builds wrote the customer/connector entity type to
 * the graph verbatim (e.g. `:pull_request` with `label: "pull_request"`), so a
 * user browsing the graph saw lower-/snake-cased type chips. Writes now coerce
 * every label to PascalCase via `sanitizeLabel` in the governed ingestion path;
 * this back-fills nodes written before that change so the
 * existing graph reads consistently (`PullRequest`, never `pull_request`). The
 * `entityType` registry-key property is deliberately left untouched — it is the
 * lowercase vocabulary slug, not a display label.
 *
 * Two passes:
 *  1. The `label` PROPERTY recase is pure Cypher and always safe (community Neo4j
 *     without APOC included). It only issues an update for distinct values that
 *     actually change.
 *  2. The structural LABEL recase needs APOC (`apoc.refactor.rename.label`). It is
 *     guarded by `db.labels()` so a graph that already holds only canonical
 *     PascalCase labels (fresh CI containers, rebuilt prod) never plans an apoc.*
 *     call — `sanitizeLabel` is idempotent on the PascalCase system labels, so
 *     they self-filter out and leave nothing to rename.
 *
 * Re-running is a no-op: once every label/property is PascalCase, both probes
 * yield zero changes.
 */
export async function pascalCaseDomainLabels(s: Session): Promise<void> {
  // ── Pass 1: recase the `label` display property (pure Cypher, no APOC) ───────
  const propProbe = await s.run(
    `MATCH (n:GraphNode) WHERE n.label IS NOT NULL RETURN DISTINCT n.label AS label`,
  );
  const propRenames = propProbe.records
    .map((r) => r.get("label") as string)
    .map((old) => ({ old, next: sanitizeLabel(old) }))
    .filter(
      (r): r is { old: string; next: string } =>
        r.next !== null && r.next !== r.old,
    );

  if (propRenames.length > 0) {
    process.stdout.write(
      JSON.stringify({
        level: "info",
        msg: "Neo4j migrate: recasing legacy node `label` properties to PascalCase",
        distinctValues: propRenames.length,
      }) + "\n",
    );
    for (const { old, next } of propRenames) {
      await s.run(
        `MATCH (n:GraphNode) WHERE n.label = $old SET n.label = $next`,
        { old, next },
      );
    }
  }

  // ── Pass 2: recase the structural Neo4j labels (needs APOC) ──────────────────
  const labelProbe = await s.run(`CALL db.labels() YIELD label RETURN label`);
  const labelRenames = labelProbe.records
    .map((r) => r.get("label") as string)
    .map((old) => ({ old, next: sanitizeLabel(old) }))
    .filter(
      (r): r is { old: string; next: string } =>
        r.next !== null && r.next !== r.old,
    );

  if (labelRenames.length === 0) return;

  process.stdout.write(
    JSON.stringify({
      level: "info",
      msg: "Neo4j migrate: recasing legacy domain node labels to PascalCase",
      labels: labelRenames.map((r) => `${r.old}->${r.next}`),
    }) + "\n",
  );

  try {
    for (const { old, next } of labelRenames) {
      // Standalone CALL (no YIELD) renames the label on every node that carries
      // it, graph-wide. Labels are not tenant-scoped, so a single rename per
      // distinct label is correct. apoc merges cleanly if the PascalCase target
      // already coexists (partially-migrated graph), keeping the pass idempotent.
      await s.run(`CALL apoc.refactor.rename.label($old, $next)`, {
        old,
        next,
      });
    }
  } catch (err) {
    throw new Error(
      `Neo4j migrate: failed to recase ${labelRenames.length} legacy domain node label(s) ` +
        `to PascalCase. This requires the APOC plugin (apoc.refactor.rename.label). Enable ` +
        `APOC on this Neo4j instance, then re-run db:migrate. Underlying error: ${String(err)}`,
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
    // Recase any legacy lower-/snake-cased domain node labels (and `label`
    // properties) to the canonical PascalCase convention. No-op on clean graphs.
    await pascalCaseDomainLabels(s);
  } finally {
    await s.close();
  }
}

// Bundle-safe direct-run guard — see @oxagen/telemetry is-direct-run.ts.
if (isDirectRunEntry(import.meta.url, process.argv[1], "migrate")) {
  migrate()
    .then(() => closeDriver())
    .then(() => {
      process.stdout.write(
        JSON.stringify({ level: "info", msg: "Neo4j migration complete" }) +
          "\n",
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      process.stderr.write(
        JSON.stringify({
          level: "error",
          msg: "Neo4j migration failed",
          err: String(err),
        }) + "\n",
      );
      process.exit(1);
    });
}
