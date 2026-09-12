import { z } from "zod";
import { defineTool } from "./_define";
import { orgDataPlaneSet, orgDataPlaneSetInputObject } from "../org.data_plane.set";
import {
  neo4jPlaneConfigSchema,
  postgresPlaneConfigSchema,
} from "../org.data_plane.shared";
import { dataPlaneKindV2Schema } from "./get-data-plane";

/**
 * Appendix E: `set_data_plane` — "approval-gated". Absorbs `set_data_plane`.
 *
 * A 1:1 carry of the fields, the two cross-field rules, and the whole governed
 * posture. Two things change, both because of §4.2 and §13.4:
 *
 *  - ClickHouse is gone as a plane kind (see `drops`, and `get_data_plane` for
 *    the reasoning), so the Postgres and Neo4j config shapes carry by import
 *    and the ClickHouse one is not referenced.
 *  - `objects` is new, and it is the one schema in this file written fresh:
 *    object storage existed in v1 only as an implicit platform bucket, so there
 *    is no source field to carry. §13.4 is the whole specification of it —
 *    "each data plane gets its own buckets with object lock… the lock runs in
 *    compliance mode, so no one, not even an admin, can lift it early."
 *
 * The output stays the REDACTED binding: setting a plane never echoes the
 * credential back. That is not symmetry for its own sake — it means a caller
 * that logs the response of a successful write has still logged nothing.
 */

/**
 * A customer-controlled object store. Written fresh — no v1 contract carried
 * object-storage configuration.
 *
 * `objectLockMode` is a literal rather than a boolean or an enum on purpose:
 * §13.4 admits exactly one setting, and a bucket in governance mode (where a
 * privileged user CAN shorten retention) would quietly void the retention
 * promise §13.1 makes. Refusing it at the trust boundary is cheaper than
 * discovering it during an audit.
 */
export const objectsPlaneConfigSchema = z.object({
  endpoint: z.string().url().max(2048),
  region: z.string().min(1).max(64),
  bucket: z.string().min(1).max(255),
  accessKeyId: z.string().min(1).max(256),
  secretAccessKey: z.string().min(1).max(1024),
  objectLockMode: z
    .literal("compliance")
    .describe(
      "§13.4: the bucket's object lock must already be in compliance mode — governance mode lets a privileged user shorten retention, which would void the seven-year promise",
    ),
});

export const setDataPlaneInputObject = z.object({
  kind: dataPlaneKindV2Schema,
  // Carried: shared = the platform plane; dedicated = a customer endpoint.
  mode: orgDataPlaneSetInputObject.shape.mode,
  config: z
    .union([
      postgresPlaneConfigSchema,
      neo4jPlaneConfigSchema,
      objectsPlaneConfigSchema,
    ])
    .optional(),
});

/**
 * The two cross-field rules, carried from `set_data_plane` with their original
 * reasoning and messages. They are restated rather than imported because the
 * source's refinement closes over a ClickHouse branch that no longer exists;
 * the per-kind config SCHEMAS are still carried by import above.
 *
 *  1. `dedicated` requires a config, `shared` forbids one. The platform plane's
 *     connection is process env, never per-organization state, so accepting a
 *     config alongside `shared` would silently store a secret nothing reads.
 *  2. The config must match the DECLARED kind. The union accepts any of the
 *     three shapes, so without this a caller could store a Neo4j URI under
 *     `kind: "objects"` and the failure would surface much later as an opaque
 *     connection error against a live customer endpoint.
 */
const setDataPlaneInput = setDataPlaneInputObject.superRefine((value, ctx) => {
  if (value.mode === "shared") {
    if (value.config !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["config"],
        message:
          "config must be omitted when mode is 'shared' — the platform plane's connection is process env, never per-organisation state",
      });
    }
    return;
  }
  if (value.config === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config"],
      message: "config is required when mode is 'dedicated'",
    });
    return;
  }
  const perKind = {
    postgres: postgresPlaneConfigSchema,
    neo4j: neo4jPlaneConfigSchema,
    objects: objectsPlaneConfigSchema,
  }[value.kind];
  if (!perKind.safeParse(value.config).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config"],
      message: `config does not match the ${value.kind} plane shape`,
    });
  }
});

export const setDataPlane = defineTool({
  name: "set_data_plane",
  domain: "org",
  description:
    "Bind one of the organization's stores (postgres, neo4j, or objects) to a dedicated customer-controlled endpoint, or return it to the shared platform plane. The connection config is envelope-encrypted at rest and is never readable back. Returns the redacted binding.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: false,

  absorbs: ["set_data_plane"],
  drops: [
    {
      field: 'kind: "clickhouse"',
      from: "set_data_plane",
      why: "§4.2 retires ClickHouse; Appendix A's org.data_planes.store is postgres | neo4j | objects. The `clickhousePlaneConfigSchema` branch of the config union goes with it",
    },
  ],

  // Carried unchanged — this is the privileged mutation the group is named for.
  // Audited as a `data_plane.updated` security event.
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "configuration",
  },
  sensitivity: "high",
  defaultEffect: "deny",
  // Empty workspace map carried deliberately: a workspace role must never
  // reach a binding that moves the whole organization's data.
  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },
  noBillingGate: true,
  // Writes org.data_planes and the KMS envelope. Carried from the source.
  mutates: true,

  input: setDataPlaneInput,

  // Identical to `get_data_plane`'s output, by construction and by intent.
  output: z.object({
    kind: dataPlaneKindV2Schema,
    mode: orgDataPlaneSet.output.shape.mode,
    status: orgDataPlaneSet.output.shape.status,
    host: orgDataPlaneSet.output.shape.host,
    database: orgDataPlaneSet.output.shape.database,
    schemaVersion: orgDataPlaneSet.output.shape.schemaVersion,
    lastVerifiedAt: orgDataPlaneSet.output.shape.lastVerifiedAt,
    rotatedAt: orgDataPlaneSet.output.shape.rotatedAt,
  }),
});

export type SetDataPlaneInput = z.output<typeof setDataPlane.input>;
export type SetDataPlaneOutput = z.output<typeof setDataPlane.output>;
