import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  auditEventsExport,
} from "./audit.events.export";

const SIGNATURE = "a".repeat(64);

describe("export_audit_events contract", () => {
  it("is registered under its name in the audit domain", () => {
    expect(getCapability("export_audit_events")?.name).toBe(
      "export_audit_events",
    );
    expect(auditEventsExport.domain).toBe("audit");
  });

  it("is a scoped, high-sensitivity read that is never a governed action", () => {
    expect(auditEventsExport.mutates).toBe(false);
    expect(auditEventsExport.scoped).toBe(true);
    expect(auditEventsExport.noBillingGate).toBe(true);
    expect(auditEventsExport.sensitivity).toBe("high");
    expect(auditEventsExport.defaultEffect).toBe("deny");
    expect(auditEventsExport.defaultRoles.org).toEqual({
      Owner: "allow",
      Admin: "allow",
    });
  });

  it("is on the API and MCP, and carries the app layer the cutover bound (WL-50)", () => {
    expect(auditEventsExport.surfaces).toEqual(["api", "mcp"]);
    // WL-50 bound it to /[org]/audit/export; apps/app/capability-ui-map.json
    // carries the binding and check:ui-parity --strict holds it.
    expect(auditEventsExport.layers).toContain("app");
  });

  it("defaults to CSV and takes the query_audit_log filters", () => {
    const parsed = auditEventsExport.input.parse({
      outcome: "deny",
      actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      from: "2026-09-01T00:00:00.000Z",
    });
    expect(parsed).toEqual({
      format: "csv",
      outcome: "deny",
      actorPublicId: "usr_7k2m9q4x8r1t5v3w6y0z2a",
      from: "2026-09-01T00:00:00.000Z",
    });
  });

  it.each([
    ["an unknown format", { format: "pdf" }],
    ["an unknown outcome", { outcome: "maybe" }],
    ["a non-ISO bound", { from: "last tuesday" }],
    ["a key the contract does not name", { limit: 10 }],
  ])("refuses %s", (_label, input) => {
    expect(auditEventsExport.input.safeParse(input).success).toBe(false);
  });

  it("answers a signed file and refuses a signature that is not hex SHA-256", () => {
    const out = {
      format: "ndjson",
      body: "",
      signature: SIGNATURE,
      algorithm: "HMAC-SHA256",
      rowCount: 0,
    };
    expect(auditEventsExport.output.parse(out)).toEqual(out);
    expect(
      auditEventsExport.output.safeParse({ ...out, signature: "not-hex" })
        .success,
    ).toBe(false);
    expect(
      auditEventsExport.output.safeParse({ ...out, algorithm: "SHA1" }).success,
    ).toBe(false);
  });

  it("names the twelve export columns and a 50,000-event bound", () => {
    expect(AUDIT_EXPORT_COLUMNS).toHaveLength(12);
    expect(AUDIT_EXPORT_COLUMNS[0]).toBe("id");
    expect(AUDIT_EXPORT_COLUMNS.at(-1)).toBe("detail");
    expect(AUDIT_EXPORT_MAX_ROWS).toBe(50_000);
  });
});
