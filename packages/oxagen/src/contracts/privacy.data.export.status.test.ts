import { describe, it, expect } from "vitest";
import { privacyDataExportStatus } from "./privacy.data.export.status";
import { getCapability } from "../registry";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("privacy.data.export.status capability", () => {
  it("is registered", () => {
    expect(getCapability("get_export_status")).toBeDefined();
  });

  it("parses an export id", () => {
    expect(() =>
      privacyDataExportStatus.input.parse({ exportId: VALID_UUID }),
    ).not.toThrow();
  });

  it("rejects an id that is not a uuid", () => {
    expect(() =>
      privacyDataExportStatus.input.parse({ exportId: "prexp_1" }),
    ).toThrow();
  });

  // The contract deliberately carries no user id: the handler matches on the
  // principal. A field here would be a way to ask after a stranger's bundle.
  it("refuses a user id in the input", () => {
    const result = privacyDataExportStatus.input.safeParse({
      exportId: VALID_UUID,
      userId: VALID_UUID,
    });
    expect(result.success).toBe(false);
  });

  it("is an unmetered, unscoped read", () => {
    expect(privacyDataExportStatus.mutates).toBe(false);
    expect(privacyDataExportStatus.scoped).toBe(false);
    expect(privacyDataExportStatus.noBillingGate).toBe(true);
  });

  // Rule 8 of the resolver is role-agnostic, so a role added later cannot fall
  // through it and lock a person out of their own export.
  it("allows any principal by default", () => {
    expect(privacyDataExportStatus.defaultEffect).toBe("allow");
  });

  // The four system org roles are Owner, Admin, Compliance and Billing --
  // there is no org-level Member or Viewer, and a map naming roles that do not
  // exist seeds nothing.
  it("names exactly the real roles at each scope", () => {
    expect(
      Object.keys(privacyDataExportStatus.defaultRoles?.org ?? {}),
    ).toEqual(["Owner", "Admin", "Compliance", "Billing"]);
    expect(
      Object.keys(privacyDataExportStatus.defaultRoles?.workspace ?? {}),
    ).toEqual(["Owner", "Member", "Viewer"]);
  });

  it("parses a ready row and a still-queued one", () => {
    expect(() =>
      privacyDataExportStatus.output.parse({
        exportId: VALID_UUID,
        status: "ready",
        downloadUrl: "https://blob.example/bundle.zip",
        completedAt: "2026-09-18T22:00:00.000Z",
      }),
    ).not.toThrow();
    expect(() =>
      privacyDataExportStatus.output.parse({
        exportId: VALID_UUID,
        status: "queued",
        downloadUrl: null,
        completedAt: null,
      }),
    ).not.toThrow();
  });

  it("rejects a status the table cannot hold", () => {
    expect(() =>
      privacyDataExportStatus.output.parse({
        exportId: VALID_UUID,
        status: "expired",
        downloadUrl: null,
        completedAt: null,
      }),
    ).toThrow();
  });
});
