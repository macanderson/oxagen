import { describe, expect, it } from "vitest";
import { secretValueUnset } from "./secret.value.unset";

describe("secret.value.unset contract", () => {
  it("registers with the correct name", () => {
    expect(secretValueUnset.name).toBe("secret.value.unset");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(secretValueUnset.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() =>
      secretValueUnset.input.parse({ keyId: "sk_1", environmentId: "env_1" }),
    ).not.toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => secretValueUnset.input.parse({ keyId: "sk_1" })).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => secretValueUnset.output.parse({ ok: true })).not.toThrow();
  });
});
