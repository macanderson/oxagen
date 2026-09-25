import { describe, expect, it } from "vitest";
import { secretKeyDelete } from "./secret.key.delete";

describe("secret.key.delete contract", () => {
  it("registers with the correct name", () => {
    expect(secretKeyDelete.name).toBe("delete_secret_key");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(secretKeyDelete.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("waits for a person's approval on the agent surface", () => {
    expect(secretKeyDelete.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "secret",
    });
  });
  it("accepts a valid input", () => {
    expect(() => secretKeyDelete.input.parse({ keyId: "sk_1" })).not.toThrow();
  });
  it("rejects input missing the required keyId", () => {
    expect(() => secretKeyDelete.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => secretKeyDelete.output.parse({ ok: true })).not.toThrow();
  });
});
