import { describe, expect, it } from "vitest";
import { apiKeyCreate } from "./api.key.create";
import { getCapability } from "../registry";

describe("api.key.create capability", () => {
  it("parses a minimal valid input", () => {
    const parsed = apiKeyCreate.input.parse({ name: "CI deploy key" });
    expect(parsed.name).toBe("CI deploy key");
    expect(parsed.scope).toEqual({});
    expect(parsed.expiresAt).toBeUndefined();
  });

  it("parses input with all fields", () => {
    const expires = "2027-01-01T00:00:00.000Z";
    const parsed = apiKeyCreate.input.parse({
      name: "prod key",
      scope: { read: true },
      expiresAt: expires,
    });
    expect(parsed.name).toBe("prod key");
    expect(parsed.scope).toEqual({ read: true });
    expect(parsed.expiresAt).toBe(expires);
  });

  it("rejects an empty name", () => {
    expect(() => apiKeyCreate.input.parse({ name: "" })).toThrow();
  });

  it("rejects a missing name", () => {
    expect(() => apiKeyCreate.input.parse({})).toThrow();
  });

  it("rejects a name over 120 characters", () => {
    expect(() => apiKeyCreate.input.parse({ name: "x".repeat(121) })).toThrow();
  });

  it("rejects a non-datetime expiresAt", () => {
    expect(() =>
      apiKeyCreate.input.parse({ name: "key", expiresAt: "not-a-date" }),
    ).toThrow();
  });

  it("parses a valid output", () => {
    const now = new Date().toISOString();
    const parsed = apiKeyCreate.output.parse({
      keyId: "00000000-0000-0000-0000-000000000001",
      publicId: "aky_abc123",
      name: "CI deploy key",
      keyPrefix: "ox_ci",
      rawKey: "ox_ci_supersecret1234",
      expiresAt: null,
      createdAt: now,
    });
    expect(parsed.rawKey).toBe("ox_ci_supersecret1234");
    expect(parsed.expiresAt).toBeNull();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("api.key.create")).toBe(apiKeyCreate);
  });

  it("is high-sensitivity and default-deny", () => {
    expect(apiKeyCreate.sensitivity).toBe("high");
    expect(apiKeyCreate.defaultEffect).toBe("deny");
  });
});
