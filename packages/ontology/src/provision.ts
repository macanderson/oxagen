/**
 * Organisation graph provisioning — spec §5.3 rules 1, 3 and 4, ADR-098.
 *
 * One interface, one call site (organisation creation), and three answers to
 * "where does this organisation's graph live":
 *
 *   pooled  Free and trial organisations. No database is created: the
 *           organisation resolves to the pooled database, scoped by property
 *           through `scopedSession()`. With a hard ceiling of 100 databases per
 *           Aura instance, provisioning on signup would spend the cap on empty
 *           tenants (rule 3). This is every organisation today.
 *   cypher  Self-managed Enterprise. `CREATE DATABASE … IF NOT EXISTS WAIT`
 *           against `system`, then the graph schema applied to the new
 *           database. Idempotent by construction (rule 4).
 *   aura    Aura Business Critical / Virtual Dedicated Cloud, where databases
 *           are created only through the Aura API, never with Cypher. NOT
 *           IMPLEMENTED: selecting it throws `OrgGraphProvisionerNotConfigured`
 *           rather than guessing at an API this repository has never been
 *           verified against. ADR-098 records the gap.
 *
 * The provisioner touches only Neo4j. Recording the answer — the
 * `org.data_planes` row the resolver routes by — belongs to the caller, which
 * holds the Postgres transaction the organisation is being created in.
 */
import type { Session } from "neo4j-driver";
import { migrate } from "./migrate";
import { orgGraphDatabaseName, systemSession } from "./org-graph";

/** Which provisioner a deployment runs for paid organisations. */
export type OrgGraphProvisionerKind = "pooled" | "cypher" | "aura";

/** The organisation being placed. */
export interface OrgGraphSubject {
  readonly orgId: string;
  /** The immutable organisation namespace (`organizations.namespace`). */
  readonly namespace: string;
}

/** Where an organisation's graph lives once provisioning returns. */
export type OrgGraphPlacement =
  | { readonly mode: "pooled" }
  | { readonly mode: "database"; readonly database: string };

export interface OrgGraphProvisioner {
  readonly kind: OrgGraphProvisionerKind;
  /** Create (or confirm) the organisation's graph. Safe to repeat. */
  provision(subject: OrgGraphSubject): Promise<OrgGraphPlacement>;
}

/** The provisioner a deployment asked for is not available in this build. */
export class OrgGraphProvisionerNotConfigured extends Error {
  readonly code = "org_graph_provisioner_not_configured" as const;
  readonly provisioner: string;
  constructor(provisioner: string, detail: string) {
    super(
      `organisation graph provisioner "${provisioner}" is not configured: ${detail}`,
    );
    this.name = "OrgGraphProvisionerNotConfigured";
    this.provisioner = provisioner;
  }
}

/** Creating or migrating an organisation database failed. */
export class OrgGraphProvisionError extends Error {
  readonly code = "org_graph_provision_failed" as const;
  readonly orgId: string;
  readonly database: string;
  constructor(subject: OrgGraphSubject, database: string, cause: unknown) {
    super(
      `failed to provision graph database ${database} for organisation ${subject.orgId}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "OrgGraphProvisionError";
    this.orgId = subject.orgId;
    this.database = database;
  }
}

/** Free and trial organisations: the pooled database, nothing created. */
export function createPooledProvisioner(): OrgGraphProvisioner {
  return {
    kind: "pooled",
    provision: async () => ({ mode: "pooled" }),
  };
}

/**
 * The statement the Cypher provisioner runs. The name travels as a PARAMETER,
 * never spliced into the text, and `orgGraphDatabaseName` has already refused
 * anything outside Neo4j's name grammar — two independent reasons no namespace
 * can change what the statement does. `IF NOT EXISTS` makes a repeat a no-op
 * and `WAIT` returns only once the database is online, so the schema step that
 * follows never races the engine.
 */
export const CREATE_ORG_DATABASE_CYPHER =
  "CREATE DATABASE $name IF NOT EXISTS WAIT";

export interface CypherProvisionerDeps {
  /** A session on `system`. Defaults to the platform driver's. */
  readonly openSystemSession?: () => Session;
  /** Apply the graph schema to one database. Defaults to `migrate`. */
  readonly migrateDatabase?: (database: string) => Promise<void>;
}

/** Self-managed Enterprise: `CREATE DATABASE` over Cypher. */
export function createCypherProvisioner(
  deps: CypherProvisionerDeps = {},
): OrgGraphProvisioner {
  const openSystemSession = deps.openSystemSession ?? systemSession;
  const migrateDatabase = deps.migrateDatabase ?? migrate;
  return {
    kind: "cypher",
    async provision(subject) {
      // A bad namespace is a caller error with its own typed code; it is not
      // wrapped as a provisioning failure.
      const database = orgGraphDatabaseName(subject.namespace);
      try {
        const s = openSystemSession();
        try {
          await s.run(CREATE_ORG_DATABASE_CYPHER, { name: database });
        } finally {
          await s.close();
        }
        // A fresh database has no constraints or indexes. Applying the schema
        // here, rather than waiting for the next deploy's migrate run, means
        // the first write lands on a database whose uniqueness rules hold.
        await migrateDatabase(database);
      } catch (err) {
        throw new OrgGraphProvisionError(subject, database, err);
      }
      return { mode: "database", database };
    },
  };
}

/**
 * Aura. Databases there are created only through the Aura API, and no Aura
 * instance or credential exists to verify an implementation against, so this
 * refuses instead of pretending. Organisation creation surfaces the typed
 * error; nothing falls back to the pool, because a paid organisation silently
 * placed in the pool is exactly the isolation downgrade the spec forbids.
 */
export function createAuraProvisioner(): OrgGraphProvisioner {
  return {
    kind: "aura",
    provision: async () => {
      throw new OrgGraphProvisionerNotConfigured(
        "aura",
        "the Aura API provider is not implemented yet (ADR-098); use NEO4J_ORG_PROVISIONER=cypher on self-managed Enterprise or pooled",
      );
    },
  };
}

/** Plans that never consume a database (spec §5.3 rule 3). */
const POOLED_PLANS = new Set(["free", "trial"]);

/**
 * Pick the provisioner for one organisation. Free and trial plans are pooled
 * whatever the deployment runs. A paid plan gets the deployment's provisioner,
 * named by `NEO4J_ORG_PROVISIONER` (default `pooled`, which is what a
 * Community Edition deployment — dev and CI — must run, since it has no
 * multi-database support). An unrecognised value is refused, not defaulted.
 */
export function selectOrgGraphProvisioner(args: {
  planType: string;
  configured?: string | undefined;
  deps?: CypherProvisionerDeps;
}): OrgGraphProvisioner {
  if (POOLED_PLANS.has(args.planType)) return createPooledProvisioner();
  const configured = args.configured ?? "pooled";
  switch (configured) {
    case "pooled":
      return createPooledProvisioner();
    case "cypher":
      return createCypherProvisioner(args.deps);
    case "aura":
      return createAuraProvisioner();
    default:
      throw new OrgGraphProvisionerNotConfigured(
        configured,
        'NEO4J_ORG_PROVISIONER must be one of "pooled", "cypher", "aura"',
      );
  }
}

/**
 * The organisation-creation entry point: select by plan and deployment, then
 * provision. Reads `NEO4J_ORG_PROVISIONER` from the process environment.
 */
export function provisionOrgGraph(
  subject: OrgGraphSubject & { readonly planType: string },
): Promise<OrgGraphPlacement> {
  return selectOrgGraphProvisioner({
    planType: subject.planType,
    configured: process.env["NEO4J_ORG_PROVISIONER"],
  }).provision(subject);
}
