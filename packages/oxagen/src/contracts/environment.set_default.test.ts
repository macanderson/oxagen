import { describe, expect, it } from "vitest";
import { environmentSetDefault } from "./environment.set_default";

const summary = {
  id: "env_1",
  name: "Production",
  slug: "production",
  description: null,
  isDefault: true,
  isActive: true,
};

describe("environment.set_default contract", () => {
  it("registers with the correct name", () => {
    expect(environmentSetDefault.name).toBe("set_default_environment");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentSetDefault.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() =>
      environmentSetDefault.input.parse({ environmentId: "env_1" }),
    ).not.toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => environmentSetDefault.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      environmentSetDefault.output.parse({ environment: summary }),
    ).not.toThrow();
  });
});
