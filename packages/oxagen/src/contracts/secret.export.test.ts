import { describe, expect, it } from "vitest";
import { secretExport } from "./secret.export";

describe("secret.export contract", () => {
  it("registers with the correct name", () => {
    expect(secretExport.name).toBe("export_secrets");
  });
  it("is reachable only via api and mcp (never the in-chat agent)", () => {
    expect(secretExport.surfaces).toEqual(["api", "mcp"]);
    expect(secretExport.surfaces).not.toContain("agent");
  });
  it("accepts a valid input (all fields optional)", () => {
    expect(() => secretExport.input.parse({})).not.toThrow();
    expect(() =>
      secretExport.input.parse({
        environmentId: "env_1",
        keyIds: ["sk_1", "sk_2"],
      }),
    ).not.toThrow();
  });
  it("rejects a non-array keyIds", () => {
    expect(() =>
      secretExport.input.parse({ keyIds: "not-an-array" }),
    ).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      secretExport.output.parse({
        env: [{ key: "FOO", value: "bar" }],
        dotenv: "FOO=bar\n",
      }),
    ).not.toThrow();
  });
});
