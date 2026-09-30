import { describe, expect, it } from "vitest";
import { secretImportEnv } from "./secret.import_env";

const validOutput = {
  rows: [
    {
      key: "FOO",
      isNewKey: true,
      sensitive: true,
      target: "default" as const,
      willOverride: false,
    },
    {
      key: "BAR",
      isNewKey: false,
      sensitive: false,
      target: "override" as const,
      willOverride: true,
    },
  ],
  committed: false,
};

describe("secret.import_env contract", () => {
  it("registers with the correct name", () => {
    expect(secretImportEnv.name).toBe("import_env_secrets");
  });
  it("exposes the api and mcp surfaces and is off the agent surface, retired (#4180)", () => {
    expect(secretImportEnv.surfaces).toEqual(["api", "mcp"]);
  });
  it("waits for a person's approval on the agent surface", () => {
    expect(secretImportEnv.agent).toEqual({
      requiresApproval: true,
      riskLevel: "high",
      category: "secret",
    });
  });
  it("accepts a valid input", () => {
    expect(() =>
      secretImportEnv.input.parse({ text: "FOO=bar" }),
    ).not.toThrow();
  });
  it("defaults `commit` to false", () => {
    expect(secretImportEnv.input.parse({ text: "FOO=bar" }).commit).toBe(false);
  });
  it("honours an explicit commit=true", () => {
    expect(
      secretImportEnv.input.parse({ text: "FOO=bar", commit: true }).commit,
    ).toBe(true);
  });
  it("rejects input missing the required text", () => {
    expect(() => secretImportEnv.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => secretImportEnv.output.parse(validOutput)).not.toThrow();
  });
});
