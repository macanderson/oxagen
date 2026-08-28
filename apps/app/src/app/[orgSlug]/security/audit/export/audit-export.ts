// audit-export.ts — serialization + HMAC signing for the signed audit-log
// export. Pure functions (node:crypto only) so they are unit-tested
// without HTTP. The route handler reads the secret from env and sets the
// signature + algorithm response headers; an auditor can re-compute the HMAC
// over the downloaded bytes to prove the export was not tampered with in
// transit or at rest.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { AuditEventRow } from "@/lib/audit-query";

export type { AuditEventRow };
export type AuditExportFormat = "ndjson" | "csv";

/** The columns we export, in stable order (also the CSV header order). */
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
] as const;

function rowValues(
  r: AuditEventRow,
): Record<(typeof AUDIT_EXPORT_COLUMNS)[number], string> {
  return {
    id: r.id,
    occurred_at: r.occurredAt.toISOString(),
    event_type: r.eventType,
    outcome: r.outcome,
    actor_user_id: r.actorUserId ?? "",
    org_id: r.orgId,
    workspace_id: r.workspaceId ?? "",
    capability: r.capability ?? "",
    ip: r.ip ?? "",
    user_agent: r.userAgent ?? "",
    request_id: r.requestId ?? "",
  };
}

/** RFC-4180 CSV field quoting. */
function csvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

export function toCSV(rows: AuditEventRow[]): string {
  const header = AUDIT_EXPORT_COLUMNS.join(",");
  const lines = rows.map((r) => {
    const v = rowValues(r);
    return AUDIT_EXPORT_COLUMNS.map((c) => csvField(v[c])).join(",");
  });
  return [header, ...lines].join("\r\n") + "\r\n";
}

export function toNDJSON(rows: AuditEventRow[]): string {
  return (
    rows.map((r) => JSON.stringify(rowValues(r))).join("\n") +
    (rows.length ? "\n" : "")
  );
}

export function serializeAuditExport(
  rows: AuditEventRow[],
  format: AuditExportFormat,
): string {
  return format === "csv" ? toCSV(rows) : toNDJSON(rows);
}

export const AUDIT_EXPORT_HMAC_ALGO = "HMAC-SHA256";

/** Hex HMAC-SHA256 of the export body under `secret`. */
export function signAuditExport(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/** Constant-time verification helper (used by tests and any verifier). */
export function verifyAuditExport(
  body: string,
  secret: string,
  signature: string,
): boolean {
  const expected = signAuditExport(body, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function exportContentType(format: AuditExportFormat): string {
  return format === "csv"
    ? "text/csv; charset=utf-8"
    : "application/x-ndjson; charset=utf-8";
}

export function exportFilename(
  format: AuditExportFormat,
  isoStamp: string,
): string {
  const safe = isoStamp.replace(/[:.]/g, "-");
  return `audit-export-${safe}.${format === "csv" ? "csv" : "ndjson"}`;
}
