import { describe, it, expect } from "vitest";
import { privacyDataExport } from "./privacy.data.export";
import { getCapability } from "../registry";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("privacy.data.export capability", () => {
  it("is registered", () => {
    expect(getCapability("export_data")).toBeDefined();
  });

  it("parses user-scope input without orgId", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "user" }),
    ).not.toThrow();
  });

  it("parses org-scope input with valid orgId", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "org", orgId: VALID_UUID }),
    ).not.toThrow();
  });

  it("rejects unknown scope", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "workspace" }),
    ).toThrow();
  });

  it("rejects org-scope with invalid orgId UUID", () => {
    expect(() =>
      privacyDataExport.input.parse({ scope: "org", orgId: "not-a-uuid" }),
    ).toThrow();
  });

  it("parses queued output without downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "queued",
      }),
    ).not.toThrow();
  });

  it("parses ready output with downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "ready",
        downloadUrl: "https://blob.example.com/export.zip",
      }),
    ).not.toThrow();
  });

  it("rejects output with invalid downloadUrl", () => {
    expect(() =>
      privacyDataExport.output.parse({
        exportId: VALID_UUID,
        status: "ready",
        downloadUrl: "not-a-url",
      }),
    ).toThrow();
  });

  it("rejects output missing exportId", () => {
    expect(() =>
      privacyDataExport.output.parse({ status: "queued" }),
    ).toThrow();
  });

  it("has defaultEffect of 'deny'", () => {
    expect(privacyDataExport.defaultEffect).toBe("deny");
  });

  it("is available on api, mcp, and agent surfaces", () => {
    expect(privacyDataExport.surfaces).toContain("api");
    expect(privacyDataExport.surfaces).toContain("mcp");
    expect(privacyDataExport.surfaces).toContain("agent");
  });

  it("is in the privacy domain", () => {
    expect(privacyDataExport.domain).toBe("privacy");
  });

  it("is async mode", () => {
    expect(privacyDataExport.mode).toBe("async");
  });
});
