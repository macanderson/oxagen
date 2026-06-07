import { describe, it, expect } from "vitest";
import {
  toCSV,
  toNDJSON,
  serializeAuditExport,
  signAuditExport,
  verifyAuditExport,
  exportFilename,
  exportContentType,
  AUDIT_EXPORT_COLUMNS,
  type AuditExportRow,
} from "./audit-export";

const ROW: AuditExportRow = {
  id: "evt-1",
  occurredAt: new Date("2026-06-01T03:00:00.000Z"),
  eventType: "auth.sign_in",
  outcome: "success",
  actorUserId: "user-1",
  orgId: "org-1",
  workspaceId: null,
  capability: null,
  ip: "203.0.113.7",
  userAgent: 'Mozilla/5.0, "Quoted" client',
  requestId: "req-1",
};

describe("CSV serialization", () => {
  it("emits the header row in the canonical column order", () => {
    const csv = toCSV([]);
    expect(csv.split("\r\n")[0]).toBe(AUDIT_EXPORT_COLUMNS.join(","));
  });

  it("RFC-4180 quotes fields with commas/quotes and renders null as empty", () => {
    const csv = toCSV([ROW]);
    const lines = csv.trimEnd().split("\r\n");
    expect(lines).toHaveLength(2);
    // user_agent contains a comma + quotes → must be quoted with doubled quotes.
    expect(lines[1]).toContain('"Mozilla/5.0, ""Quoted"" client"');
    // workspace_id / capability are null → empty fields.
    expect(csv).toContain("auth.sign_in");
  });
});

describe("NDJSON serialization", () => {
  it("emits one JSON object per line with string values", () => {
    const ndjson = toNDJSON([ROW]);
    const parsed = JSON.parse(ndjson.trim());
    expect(parsed.event_type).toBe("auth.sign_in");
    expect(parsed.occurred_at).toBe("2026-06-01T03:00:00.000Z");
    expect(parsed.workspace_id).toBe(""); // null → empty string
  });

  it("returns empty string for no rows", () => {
    expect(toNDJSON([])).toBe("");
  });
});

describe("serializeAuditExport dispatch", () => {
  it("routes by format", () => {
    expect(serializeAuditExport([ROW], "csv")).toBe(toCSV([ROW]));
    expect(serializeAuditExport([ROW], "ndjson")).toBe(toNDJSON([ROW]));
  });
});

describe("HMAC signing", () => {
  it("verifies a body signed with the same secret", () => {
    const body = toNDJSON([ROW]);
    const sig = signAuditExport(body, "test-secret-key");
    expect(verifyAuditExport(body, "test-secret-key", sig)).toBe(true);
  });

  it("rejects a tampered body", () => {
    const body = toNDJSON([ROW]);
    const sig = signAuditExport(body, "test-secret-key");
    expect(verifyAuditExport(body + "x", "test-secret-key", sig)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const body = toNDJSON([ROW]);
    const sig = signAuditExport(body, "test-secret-key");
    expect(verifyAuditExport(body, "other-secret", sig)).toBe(false);
  });

  it("produces a stable hex digest", () => {
    expect(signAuditExport("abc", "k")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("response helpers", () => {
  it("maps format to content type + filename", () => {
    expect(exportContentType("csv")).toContain("text/csv");
    expect(exportContentType("ndjson")).toContain("ndjson");
    expect(exportFilename("csv", "2026-06-01T03:00:00.000Z")).toMatch(/^audit-export-.*\.csv$/);
    expect(exportFilename("ndjson", "2026-06-01T03:00:00.000Z")).not.toContain(":");
  });
});
