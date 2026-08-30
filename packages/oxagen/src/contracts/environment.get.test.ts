import { describe, expect, it } from "vitest";
import { environmentGet } from "./environment.get";

const summary = {
  id: "env_1",
  name: "Production",
  slug: "production",
  description: "primary",
  isDefault: true,
  isActive: true,
};

describe("environment.get contract", () => {
  it("registers with the correct name", () => {
    expect(environmentGet.name).toBe("get_environment");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentGet.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() =>
      environmentGet.input.parse({ environmentId: "env_1" }),
    ).not.toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => environmentGet.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      environmentGet.output.parse({ environment: summary }),
    ).not.toThrow();
  });
});
