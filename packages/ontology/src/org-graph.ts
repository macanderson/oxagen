/**
 * Naming and discovery for organisation graph databases (spec §5.3, ADR-098).
 *
 * The tenant boundary on the graph is the DATABASE: an organisation on a paid
 * plan gets its own database on the platform cluster, and a query cannot cross
 * databases without a composite database, which Oxagen never creates. This
 * module owns the one rule for what that database is called, so the
 * provisioner that creates it, the resolver that routes to it and the migrator
 * that keeps its schema current can never disagree.
 */
import type { Session } from "neo4j-driver";
import { driver } from "./client";

/**
 * Prefix of every organisation database. The spec writes `org_<namespace>`,
 * but Neo4j refuses an underscore in a database name — the first character must
 * be an ASCII letter and the rest letters, digits, dots or dashes — so the
 * separator is a dash. Recorded in ADR-098.
 */
export const ORG_GRAPH_DATABASE_PREFIX = "org-";

/**
 * Neo4j's database-name grammar: 3–63 characters, an ASCII letter first, then
 * lowercase letters, digits, dots and dashes. Names are case-insensitive and
 * normalised to lowercase by the engine, so only the lowercase form is valid
 * here — two spellings of one name must not both be accepted.
 */
const NEO4J_DATABASE_NAME = /^[a-z][a-z0-9.-]{2,62}$/;

/**
 * A namespace as the organisation CHECK constraint admits it, lowercased:
 * 2-6 ASCII letters or digits. The provisioner names a database from nothing
 * else, so this is also the whole set of names discovery may hand back.
 */
const ORG_NAMESPACE = /^[a-z0-9]{2,6}$/;

/** Raised when an organisation namespace cannot name a database. */
export class OrgGraphNameError extends Error {
  readonly code = "org_graph_name_invalid" as const;
  constructor(namespace: string) {
    super(
      `organisation namespace ${JSON.stringify(namespace)} cannot name a Neo4j database; ` +
        "a namespace is 2-6 lowercase ASCII letters or digits",
    );
    this.name = "OrgGraphNameError";
  }
}

/**
 * The database an organisation's graph lives in: `org-<namespace>`. The
 * namespace is the organisation's IMMUTABLE handle (a trigger refuses to change
 * it), unlike the renameable slug, so the name is stable for the life of the
 * organisation. It is lowercased and validated rather than escaped: a name that
 * needs escaping is a namespace the database CHECK should never have admitted,
 * and refusing it is safer than inventing a spelling for it.
 */
export function orgGraphDatabaseName(namespace: string): string {
  const ns = namespace.toLowerCase();
  if (!ORG_NAMESPACE.test(ns)) throw new OrgGraphNameError(namespace);
  const name = `${ORG_GRAPH_DATABASE_PREFIX}${ns}`;
  // Unreachable while the namespace rule above holds; kept so a future change
  // to that rule cannot produce a name the engine would refuse at runtime.
  if (!NEO4J_DATABASE_NAME.test(name)) throw new OrgGraphNameError(namespace);
  return name;
}

/**
 * Exactly the names `orgGraphDatabaseName` can produce: the prefix and then a
 * namespace the CHECK constraint admits. The two rules are one rule read from
 * both ends, and the difference matters: `listOrgGraphDatabases` feeds every
 * name this accepts to the migrator, which applies schema DDL, recases labels
 * and merges duplicate nodes. On a self-managed Enterprise cluster a database
 * someone else named `org-analytics` is a legal Neo4j name under the prefix,
 * and the prefix alone would have migrated it.
 */
export function isOrgGraphDatabaseName(name: string): boolean {
  if (!name.startsWith(ORG_GRAPH_DATABASE_PREFIX)) return false;
  const namespace = name.slice(ORG_GRAPH_DATABASE_PREFIX.length);
  return (
    ORG_NAMESPACE.test(namespace) && orgGraphDatabaseName(namespace) === name
  );
}

/** Open a session on the `system` database, where admin commands run. */
export function systemSession(): Session {
  return driver().session({ database: "system" });
}

/**
 * Every organisation database the engine currently holds, read from
 * `SHOW DATABASES` on `system`. Community Edition holds only `neo4j` and
 * `system`, so this is empty there.
 */
export async function listOrgGraphDatabases(
  open: () => Session = systemSession,
): Promise<string[]> {
  const s = open();
  try {
    const res = await s.run("SHOW DATABASES YIELD name RETURN DISTINCT name");
    return res.records
      .map((r) => r.get("name") as string)
      .filter(isOrgGraphDatabaseName)
      .sort();
  } finally {
    await s.close();
  }
}
