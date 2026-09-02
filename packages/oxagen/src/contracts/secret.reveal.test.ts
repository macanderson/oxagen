import { describe, expect, it } from "vitest";
import { secretReveal } from "./secret.reveal";

describe("secret.reveal contract", () => {
  it("registers with the correct name", () => {
    expect(secretReveal.name).toBe("reveal_secret");
  });
  it("is reachable only via api and mcp (never the in-chat agent)", () => {
    expect(secretReveal.surfaces).toEqual(["api", "mcp"]);
    expect(secretReveal.surfaces).not.toContain("agent");
  });
  it("accepts a valid input", () => {
    expect(() => secretReveal.input.parse({ keyId: "sk_1" })).not.toThrow();
    expect(() =>
      secretReveal.input.parse({ keyId: "sk_1", environmentId: "env_1" }),
    ).not.toThrow();
  });
  it("rejects input missing the required keyId", () => {
    expect(() => secretReveal.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      secretReveal.output.parse({
        key: "FOO",
        value: "bar",
        source: "override",
      }),
    ).not.toThrow();
    expect(() =>
      secretReveal.output.parse({ key: "FOO", value: null, source: "unset" }),
    ).not.toThrow();
  });
});
