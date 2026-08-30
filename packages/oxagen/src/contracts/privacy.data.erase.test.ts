import { describe, it, expect } from "vitest";
import { privacyDataErase } from "./privacy.data.erase";
import { getCapability } from "../registry";

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const ISO_FUTURE = "2026-07-09T00:00:00.000Z";

describe("privacy.data.erase capability", () => {
  it("is registered", () => {
    expect(getCapability("erase_data")).toBeDefined();
  });

  it("parses user-scope input with confirm: true", () => {
    expect(() =>
      privacyDataErase.input.parse({ scope: "user", confirm: true }),
    ).not.toThrow();
  });

  it("parses org-scope input with valid orgId and confirm: true", () => {
    expect(() =>
      privacyDataErase.input.parse({
        scope: "org",
        orgId: VALID_UUID,
        confirm: true,
      }),
    ).not.toThrow();
  });

  it("rejects input without confirm field", () => {
    expect(() => privacyDataErase.input.parse({ scope: "user" })).toThrow();
  });

  it("rejects confirm: false", () => {
    expect(() =>
      privacyDataErase.input.parse({ scope: "user", confirm: false }),
    ).toThrow();
  });

  it("rejects unknown scope", () => {
    expect(() =>
      privacyDataErase.input.parse({ scope: "workspace", confirm: true }),
    ).toThrow();
  });

  it("rejects org-scope with invalid orgId UUID", () => {
    expect(() =>
      privacyDataErase.input.parse({
        scope: "org",
        orgId: "bad-uuid",
        confirm: true,
      }),
    ).toThrow();
  });

  it("parses valid output", () => {
    expect(() =>
      privacyDataErase.output.parse({
        requestId: VALID_UUID,
        status: "queued",
        effectiveAt: ISO_FUTURE,
      }),
    ).not.toThrow();
  });

  it("rejects output with status other than 'queued'", () => {
    expect(() =>
      privacyDataErase.output.parse({
        requestId: VALID_UUID,
        status: "processing",
        effectiveAt: ISO_FUTURE,
      }),
    ).toThrow();
  });

  it("rejects output with non-datetime effectiveAt", () => {
    expect(() =>
      privacyDataErase.output.parse({
        requestId: VALID_UUID,
        status: "queued",
        effectiveAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("has defaultEffect of 'deny'", () => {
    expect(privacyDataErase.defaultEffect).toBe("deny");
  });

  it("is available on api, mcp, and agent surfaces", () => {
    expect(privacyDataErase.surfaces).toContain("api");
    expect(privacyDataErase.surfaces).toContain("mcp");
    expect(privacyDataErase.surfaces).toContain("agent");
  });

  it("requires agent approval", () => {
    expect(privacyDataErase.agent?.requiresApproval).toBe(true);
  });

  it("has destructive sensitivity", () => {
    expect(privacyDataErase.sensitivity).toBe("destructive");
  });

  it("is in the privacy domain", () => {
    expect(privacyDataErase.domain).toBe("privacy");
  });
});
