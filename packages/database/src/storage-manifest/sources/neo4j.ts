// Neo4j source — parses node labels + constraints + indexes from schema.cypher.
//
// packages/ontology/src/schema.cypher is the idempotent DDL for the graph store
// (all statements are CREATE ... IF NOT EXISTS). Neo4j is schema-optional, so
// there is no column list; instead a "table" here is a NODE LABEL, and its
// structure is the set of key properties named by its constraints/indexes plus
// the constraint/index inventory. Parsing the committed cypher is deterministic.
//
// Grammar handled (idempotent CREATE forms only; the file's trailing MATCH ...
// SET relabel/backfill statements are data migrations, not schema, and are
// ignored):
//   CREATE CONSTRAINT <n> IF NOT EXISTS FOR (x:Label) REQUIRE x.prop IS UNIQUE
//   CREATE CONSTRAINT <n> IF NOT EXISTS FOR (x:Label) REQUIRE (x.a, x.b) IS UNIQUE
//   CREATE [VECTOR] INDEX <n> IF NOT EXISTS FOR (x:Label) ON (x.a[, x.b])

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { ManifestColumn, ManifestTable } from "../types";
import { assignDomain } from "../domains";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the Neo4j schema DDL (packages/ontology/src/schema.cypher). */
export const NEO4J_SCHEMA_PATH = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "ontology",
  "src",
  "schema.cypher",
);

/** Store-qualified id for a Neo4j node label, e.g. "neo4j:Execution". */
export function neo4jLabelId(label: string): string {
  return `neo4j:${label}`;
}

interface LabelAccumulator {
  label: string;
  properties: Set<string>;
  constraints: string[];
  indexes: string[];
  vectorIndexes: string[];
  /**
   * True when any index/constraint references orgId — the tenant scope key.
   * Under-reports: a label scoped by workspaceId alone (:EntityNode, indexed on
   * (workspaceId, entityType)) leaves this false even though its rows are
   * tenant-owned. Widening the check to workspaceId would change the manifest's
   * bytes and hash, so it is a deliberate follow-up, not a drive-by edit.
   */
  orgScoped: boolean;
}

function ensure(
  map: Map<string, LabelAccumulator>,
  label: string,
): LabelAccumulator {
  let acc = map.get(label);
  if (!acc) {
    acc = {
      label,
      properties: new Set(),
      constraints: [],
      indexes: [],
      vectorIndexes: [],
      orgScoped: false,
    };
    map.set(label, acc);
  }
  return acc;
}

/** Extract bare property names from a cypher "(x.a, x.b)" / "x.a" fragment. */
function propNames(raw: string | undefined): string[] {
  return (raw?.match(/\.\s*(\w+)/g) ?? []).map((p) => p.replace(/^\.\s*/, ""));
}

/**
 * Parse a schema.cypher string into ManifestTables (one per node label).
 * Exported pure for unit tests. Labels are sorted by id; a label's properties
 * are the union of every property named by its constraints/indexes, sorted.
 */
export function parseCypherSchema(cypher: string): ManifestTable[] {
  const byLabel = new Map<string, LabelAccumulator>();

  // Uniqueness constraints: FOR (x:Label) REQUIRE x.prop | (x.a, x.b) IS ... UNIQUE
  const constraintRe =
    /CREATE\s+CONSTRAINT\s+(\w+)\s+IF\s+NOT\s+EXISTS\s+FOR\s*\(\s*\w+\s*:\s*(\w+)\s*\)\s*REQUIRE\s*(\([^)]*\)|[\w.]+)\s+IS(?:\s+\w+)*\s+UNIQUE/gi;
  let m: RegExpExecArray | null;
  while ((m = constraintRe.exec(cypher))) {
    const label = m[2];
    const cname = m[1];
    if (!label || !cname) continue;
    const acc = ensure(byLabel, label);
    const props = propNames(m[3]);
    for (const p of props) acc.properties.add(p);
    acc.constraints.push(cname);
    if (props.some((p) => p.toLowerCase() === "orgid")) acc.orgScoped = true;
  }

  // Indexes (plain + vector): CREATE [VECTOR] INDEX <n> ... FOR (x:Label) ON (x.a, x.b)
  const indexRe =
    /CREATE\s+(VECTOR\s+)?INDEX\s+(\w+)\s+IF\s+NOT\s+EXISTS\s+FOR\s*\(\s*\w+\s*:\s*(\w+)\s*\)\s*ON\s*\(([^)]*)\)/gi;
  while ((m = indexRe.exec(cypher))) {
    const isVector = m[1];
    const iname = m[2];
    const label = m[3];
    if (!iname || !label) continue;
    const acc = ensure(byLabel, label);
    const props = propNames(m[4]);
    for (const p of props) acc.properties.add(p);
    if (isVector) acc.vectorIndexes.push(iname);
    else acc.indexes.push(iname);
    if (props.some((p) => p.toLowerCase() === "orgid")) acc.orgScoped = true;
  }

  const tables: ManifestTable[] = [];
  for (const acc of byLabel.values()) {
    // Properties become "columns" — Neo4j has no fixed schema, so these are the
    // KEY/indexed properties the graph model constrains, not an exhaustive list.
    const columns: ManifestColumn[] = [...acc.properties]
      .sort()
      .map((name) => ({
        name,
        type: "property", // Neo4j is schema-optional; property types are runtime
        nullable: true,
        primaryKey: name === "publicId" || name === "id",
      }));

    // Dedupe + sort each inventory so repeated declarations cannot make the
    // meta value — and thus the content hash — depend on declaration count.
    const uniqSorted = (xs: string[]): string =>
      [...new Set(xs)].sort().join(",");
    const meta: Record<string, string> = {};
    if (acc.constraints.length) meta.constraints = uniqSorted(acc.constraints);
    if (acc.indexes.length) meta.indexes = uniqSorted(acc.indexes);
    if (acc.vectorIndexes.length)
      meta.vectorIndexes = uniqSorted(acc.vectorIndexes);

    tables.push({
      id: neo4jLabelId(acc.label),
      store: "neo4j",
      domain: assignDomain("neo4j", acc.label),
      name: acc.label,
      tenantScoped: acc.orgScoped,
      columns,
      meta,
    });
  }
  tables.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return tables;
}

/** Read + parse the Neo4j schema.cypher from disk. */
export function collectNeo4jLabels(): ManifestTable[] {
  const cypher = readFileSync(NEO4J_SCHEMA_PATH, "utf8");
  return parseCypherSchema(cypher);
}
