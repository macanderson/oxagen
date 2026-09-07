import { z } from "zod";

/**
 * Shared wire schemas for the ADR-042 organisation-scoped data-plane
 * capabilities. Not a capability itself — `get_data_plane` and
 * `set_data_plane` both import from here so the two surfaces can never drift
 * on what a plane kind, mode, or redacted binding looks like.
 */

/** The three stores that can be bound per organisation. */
export const dataPlaneKindSchema = z.enum([
  "postgres",
  "neo4j",
  "clickhouse",
]);

/** shared = the platform plane; dedicated = a customer-controlled endpoint. */
export const dataPlaneModeSchema = z.enum(["shared", "dedicated"]);

/** Only `active` admits traffic; the other two make scoped access fail closed. */
export const dataPlaneStatusSchema = z.enum([
  "active",
  "degraded",
  "disabled",
]);

/**
 * A hostname or IP for a customer-controlled endpoint. Deliberately permissive
 * on shape (customers use internal DNS, IPv6 literals, and private suffixes)
 * but bounded in length so a hostile value cannot inflate a log line or a DSN.
 */
const hostSchema = z.string().min(1).max(255);

/**
 * Plaintext connection configuration, discriminated by store kind. This is the
 * ONLY place plaintext credentials enter the platform: the handler
 * envelope-encrypts the whole object with the KMS envelope before it touches a
 * column, and no read capability ever returns these fields.
 */
export const postgresPlaneConfigSchema = z.object({
  host: hostSchema,
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().min(1).max(128),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  // TLS defaults ON: the connection crosses a network the platform does not
  // control, so plaintext must be an explicit opt-out.
  ssl: z.boolean().default(true),
  maxConnections: z.number().int().min(1).max(100).optional(),
});

export const neo4jPlaneConfigSchema = z.object({
  // Scheme included — the driver needs bolt/neo4j(+s/+ssc) to pick a transport.
  uri: z
    .string()
    .min(1)
    .max(2048)
    .regex(
      /^(bolt|neo4j)(\+s|\+ssc)?:\/\/.+/,
      "uri must be a bolt:// or neo4j:// URI (optionally +s / +ssc)",
    ),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  database: z.string().min(1).max(128),
});

export const clickhousePlaneConfigSchema = z.object({
  url: z.string().url().max(2048),
  username: z.string().min(1).max(128),
  password: z.string().min(1).max(1024),
  database: z.string().min(1).max(128),
});

export const dataPlaneConfigSchema = z.union([
  postgresPlaneConfigSchema,
  neo4jPlaneConfigSchema,
  clickhousePlaneConfigSchema,
]);

/**
 * The REDACTED binding both capabilities return.
 *
 * ADR-042 §4: "the raw DSN is never returned by any read capability." What
 * survives is what an operator needs to confirm the binding is the right one —
 * where it points and whether it is healthy — and nothing that could
 * reconstruct a connection: no password, no username, no port, no full URI.
 * `host` and `database` are non-secret identifiers the customer supplied and
 * already knows.
 */
export const dataPlaneBindingSchema = z.object({
  kind: dataPlaneKindSchema,
  mode: dataPlaneModeSchema,
  status: dataPlaneStatusSchema,
  /** Endpoint host of a dedicated plane; null for the shared plane. */
  host: z.string().nullable(),
  /** Database / graph name on a dedicated plane; null for the shared plane. */
  database: z.string().nullable(),
  /** Applied schema version of a dedicated plane; null when unknown. */
  schemaVersion: z.string().nullable(),
  /** ISO-8601 timestamp of the last successful health verification. */
  lastVerifiedAt: z.string().nullable(),
  /** ISO-8601 timestamp of the last credential rotation. */
  rotatedAt: z.string().nullable(),
});

export type DataPlaneKindValue = z.output<typeof dataPlaneKindSchema>;
export type DataPlaneBindingDto = z.output<typeof dataPlaneBindingSchema>;
export type PostgresPlaneConfigInput = z.output<
  typeof postgresPlaneConfigSchema
>;
export type Neo4jPlaneConfigInput = z.output<typeof neo4jPlaneConfigSchema>;
export type ClickHousePlaneConfigInput = z.output<
  typeof clickhousePlaneConfigSchema
>;
