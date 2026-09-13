import { z } from "zod";
import { defineTool } from "./_define";
import { orgDataPlaneGet } from "../org.data_plane.get";

/**
 * Appendix E: `get_data_plane` — "plane binding, DSN never returned". Absorbs
 * `get_data_plane`.
 *
 * A 1:1 carry of every field, with one change to a VALUE inside the `kind`
 * enum rather than to the field list. §4.2 retires ClickHouse — "its two jobs,
 * append-only trace rows and spend analytics, are now covered by frame nodes in
 * the graph plus Postgres rollups" — and Appendix A's `org.data_planes.store`
 * reads `postgres`, `neo4j`, `objects`. Object storage is a plane in its own
 * right in v2 (§13.4: each data plane gets its own buckets with object lock),
 * and it had no v1 representation at all.
 *
 * The redaction rule is the whole point of the tool and is unchanged. ADR-042
 * §4: the raw DSN is never returned by any read capability. What comes back is
 * what an operator needs to confirm the binding is the right one — where it
 * points and whether it is healthy — and nothing that could reconstruct a
 * connection. There is no read-back path for a credential by design; an
 * operator who needs to change one calls `set_data_plane`.
 */

/** Appendix A `org.data_planes.store`. Shared with `set_data_plane`. */
export const dataPlaneKindV2Schema = z.enum(["postgres", "neo4j", "objects"]);

export const getDataPlane = defineTool({
  name: "get_data_plane",
  domain: "org",
  description:
    "Read the organization's data-plane binding for one store (postgres, neo4j, or objects): shared or dedicated, its health status, endpoint host and database or bucket name, applied schema version, and the last verification and rotation timestamps. Never returns credentials or a connection string.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  /**
   * Carried: a data plane binds the whole organization — the customer's
   * firewall is an organization property, not a workspace one (ADR-042
   * alternatives), and Appendix A puts `org.data_planes` at class `org`.
   */
  scoped: false,

  absorbs: ["get_data_plane"],
  drops: [
    {
      field: 'kind: "clickhouse"',
      from: "get_data_plane",
      why: "§4.2 retires ClickHouse; its trace rows and spend analytics move to frame nodes in the graph plus Postgres rollups, and Appendix A's org.data_planes.store is postgres | neo4j | objects. `objects` replaces it — §13.4 makes per-organization buckets with object lock a plane of their own",
    },
  ],

  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "configuration",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  // Carried unchanged, including the empty workspace map, which is deliberate:
  // a workspace role must never reach a binding that moves the whole
  // organization's data.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  // Carried: reading where an organization's data lives is governance, not AI
  // usage, so a zero credit balance must not hide it.
  noBillingGate: true,
  /**
   * `false`, confirmed against packages/handlers/src/org.data_plane.get.ts,
   * whose own header calls it "a read-only binding fetch that returns NO secret
   * material" and marks it audit-exempt; the only writes in that file's sibling
   * are in `org.data_plane.set`.
   */
  mutates: false,

  input: z.object({ kind: dataPlaneKindV2Schema }),

  // The redacted binding, field for field from `dataPlaneBindingSchema` — each
  // one keeps the doc comment that says why it is safe to return.
  output: z.object({
    kind: dataPlaneKindV2Schema,
    mode: orgDataPlaneGet.output.shape.mode,
    status: orgDataPlaneGet.output.shape.status,
    host: orgDataPlaneGet.output.shape.host,
    database: orgDataPlaneGet.output.shape.database,
    schemaVersion: orgDataPlaneGet.output.shape.schemaVersion,
    lastVerifiedAt: orgDataPlaneGet.output.shape.lastVerifiedAt,
    rotatedAt: orgDataPlaneGet.output.shape.rotatedAt,
  }),
});

export type GetDataPlaneInput = z.output<typeof getDataPlane.input>;
export type GetDataPlaneOutput = z.output<typeof getDataPlane.output>;
