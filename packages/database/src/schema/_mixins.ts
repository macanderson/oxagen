import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  jsonb,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// citext keeps slug/email comparisons case-insensitive at the column level
// rather than wrapping every WHERE clause in lower(). Requires the citext
// extension; the initial migration creates it.
export const citext = customType<{ data: string; driverData: string }>({
  dataType() {
    return "citext";
  },
});

// ltree for hierarchical paths (workspace.folders). Spec §6.3.
export const ltree = customType<{ data: string; driverData: string }>({
  dataType() {
    return "ltree";
  },
});

// bytea for envelope-encrypted columns — Drizzle has no first-class bytea
// helper, so we declare it via customType. The service layer is responsible
// for encrypt/decrypt (see @oxagen/crypto); the column stores an opaque Buffer.
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return "bytea";
  },
});

// UUIDv7 default. The initial migration installs the uuidv7() function
// or the pg_uuidv7 extension; if neither is available we fall back to
// uuid_generate_v4 from uuid-ossp (also installed by the initial
// migration). Production should run on a Postgres that supports v7.
export const uuidv7Default = sql`COALESCE(
  CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
    THEN uuid_generate_v7()
    ELSE uuid_generate_v4()
  END,
  uuid_generate_v4()
)`;

/**
 * id_mixin — internal UUIDv7 + prefixed public id.
 * Pass the prefix (`agt`, `wrk`, etc.) per spec §4.3.
 */
export const idMixin = (publicIdPrefix: string) => ({
  id: uuid("id").primaryKey().default(uuidv7Default),
  publicId: citext("public_id")
    .notNull()
    .unique()
    .$defaultFn(() => `${publicIdPrefix}_${cryptoRandom(22)}`),
});

/** audit_mixin — created/updated timestamps and authoring user. */
export const auditMixin = () => ({
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  createdByUserId: uuid("created_by_user_id"),
  updatedByUserId: uuid("updated_by_user_id"),
});

/** soft_delete_mixin — hard deletes prohibited on org-scoped tables. */
export const softDeleteMixin = () => ({
  deletedAt: timestamp("deleted_at", { withTimezone: true, mode: "date" }),
  deletedByUserId: uuid("deleted_by_user_id"),
});

/** org_scope_mixin — required on every org-owned table. */
export const orgScopeMixin = () => ({
  orgId: uuid("org_id").notNull(),
  workspaceId: uuid("workspace_id").notNull(),
});

/** version_mixin — immutable snapshots: agent/tool/playbook/prompt versions. */
export const versionMixin = () => ({
  versionNumber: integer("version_number").notNull(),
  isLatest: boolean("is_latest").notNull().default(false),
  parentVersionId: uuid("parent_version_id"),
  publishedAt: timestamp("published_at", { withTimezone: true, mode: "date" }),
});

/** execution_status_mixin — lifecycle timestamps + status check constraint. */
export const executionStatusMixin = () => ({
  status: citext("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true, mode: "date" }),
  completedAt: timestamp("completed_at", { withTimezone: true, mode: "date" }),
  failedAt: timestamp("failed_at", { withTimezone: true, mode: "date" }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: "date" }),
});

/** json_contract_mixin — input/output schemas + config + metadata. */
export const jsonContractMixin = () => ({
  inputSchema: jsonb("input_schema").notNull(),
  outputSchema: jsonb("output_schema").notNull(),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
  metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
});

// Crockford base32, 22 chars ≈ 110 bits of entropy. Browser & Node both
// provide globalThis.crypto in modern runtimes.
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function cryptoRandom(length: number): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += CROCKFORD[b % 32];
  return out.toLowerCase();
}

export const allowedExecutionStatuses = [
  "pending",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type ExecutionStatus = (typeof allowedExecutionStatuses)[number];
