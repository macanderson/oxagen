import { describe, expect, it } from "vitest";
import { environmentCreate } from "./environment.create";

const summary = {
  id: "env_1",
  name: "Production",
  slug: "production",
  description: null,
  isDefault: true,
  isActive: true,
};

describe("environment.create contract", () => {
  it("registers with the correct name", () => {
    expect(environmentCreate.name).toBe("create_environment");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentCreate.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() =>
      environmentCreate.input.parse({ name: "Production", slug: "production" }),
    ).not.toThrow();
  });
  it("rejects input missing the required name", () => {
    expect(() =>
      environmentCreate.input.parse({ slug: "production" }),
    ).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      environmentCreate.output.parse({ environment: summary }),
    ).not.toThrow();
  });
});
