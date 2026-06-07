import { describe, expect, it } from "vitest";
import { apiKeyRevoke } from "./api.key.revoke";
import { getCapability } from "../registry";

describe("api.key.revoke capability", () => {
  it("parses a valid input", () => {
    const parsed = apiKeyRevoke.input.parse({ keyPublicId: "aky_abc123" });
    expect(parsed.keyPublicId).toBe("aky_abc123");
  });

  it("rejects an empty keyPublicId", () => {
    expect(() => apiKeyRevoke.input.parse({ keyPublicId: "" })).toThrow();
  });

  it("rejects a missing keyPublicId", () => {
    expect(() => apiKeyRevoke.input.parse({})).toThrow();
  });

  it("parses a valid output", () => {
    const now = new Date().toISOString();
    const parsed = apiKeyRevoke.output.parse({
      revoked: true,
      keyPublicId: "aky_abc123",
      revokedAt: now,
    });
    expect(parsed.revoked).toBe(true);
    expect(parsed.revokedAt).toBe(now);
  });

  it("rejects a non-boolean revoked in output", () => {
    expect(() =>
      apiKeyRevoke.output.parse({ revoked: "yes", keyPublicId: "aky_abc123", revokedAt: "" }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("api.key.revoke")).toBe(apiKeyRevoke);
  });

  it("is high-sensitivity, default-deny, and requires agent approval", () => {
    expect(apiKeyRevoke.sensitivity).toBe("high");
    expect(apiKeyRevoke.defaultEffect).toBe("deny");
    expect(apiKeyRevoke.agent?.requiresApproval).toBe(true);
  });
});
