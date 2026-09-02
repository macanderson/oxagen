import { describe, expect, it } from "vitest";
import { secretValueSet } from "./secret.value.set";

describe("secret.value.set contract", () => {
  it("registers with the correct name", () => {
    expect(secretValueSet.name).toBe("set_secret_value");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(secretValueSet.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input (including empty string value)", () => {
    expect(() =>
      secretValueSet.input.parse({
        keyId: "sk_1",
        environmentId: "env_1",
        value: "s3cret",
      }),
    ).not.toThrow();
    expect(() =>
      secretValueSet.input.parse({
        keyId: "sk_1",
        environmentId: "env_1",
        value: "",
      }),
    ).not.toThrow();
  });
  it("rejects input missing the required value", () => {
    expect(() =>
      secretValueSet.input.parse({ keyId: "sk_1", environmentId: "env_1" }),
    ).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => secretValueSet.output.parse({ ok: true })).not.toThrow();
  });
});
