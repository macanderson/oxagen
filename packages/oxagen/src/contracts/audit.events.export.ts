/**
 * `export_audit_events`: the organization's security audit events over the
 * filters `query_audit_log` takes, serialized as CSV or NDJSON and signed with
 * HMAC-SHA256, so an auditor can prove the file was not changed after it left
 * Oxagen. The handler is the deprecated app's signed export
 * (`apps/app_deprecated/.../security/audit/export`) moved behind a contract.
 *
 * An export is all or nothing: a store failure mid-walk refuses the export
 * rather than signing a short file, and a filter matching more than the
 * export bound is `invalid_input` with the bound in the message.
 *
 * Reading the record is never a governed action (`noBillingGate`, ADR-052
 * exclusion 2), and every tier may export it (spec §20 row 3, 2026-09-15).
 * Org Owner or Admin, checked in the handler (INV-29).
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { auditEventFilters } from "./audit.log.query";

/** The columns of an export row, in order; the CSV header is this line. */
export const AUDIT_EXPORT_COLUMNS = [
  "id",
  "occurred_at",
  "event_type",
  "outcome",
  "actor_user_id",
  "org_id",
  "workspace_id",
  "capability",
  "ip",
  "user_agent",
  "request_id",
  "detail",
] as const;

/** The most events one export carries. */
export const AUDIT_EXPORT_MAX_ROWS = 50_000;

const auditExportFormat = z.enum(["csv", "ndjson"]);

export const auditEventsExport = registerCapability({
  name: "export_audit_events",
  domain: "audit",
  description:
    "Export the org's security audit events over the query_audit_log filters as CSV or NDJSON, signed with HMAC-SHA256 so the file can be verified after download. Up to 50,000 events; a wider match is refused.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  sensitivity: "high",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    // An export answers for the whole organization, so no workspace role
    // grants it; `query_audit_log` admits a workspace Owner because it can be
    // narrowed to one workspace, and this cannot.
    workspace: {},
  },
  input: z
    .object({
      format: auditExportFormat
        .default("csv")
        .describe("csv (RFC 4180) or ndjson, one object per line"),
      ...auditEventFilters,
    })
    .strict(),
  output: z
    .object({
      format: auditExportFormat,
      /** The file: a CSV header then one line per event, or one JSON object per line. */
      body: z.string(),
      /** Hex HMAC-SHA256 of `body` under the export signing key. */
      signature: z.string().regex(/^[0-9a-f]{64}$/),
      algorithm: z.literal("HMAC-SHA256"),
      /** Events in the file. */
      rowCount: z.number().int().nonnegative(),
    })
    .strict(),
});

export type AuditEventsExportInput = z.output<typeof auditEventsExport.input>;
export type AuditEventsExportOutput = z.output<typeof auditEventsExport.output>;
