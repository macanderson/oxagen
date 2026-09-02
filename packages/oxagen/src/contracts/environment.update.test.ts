import { describe, expect, it } from "vitest";
import { environmentUpdate } from "./environment.update";

const summary = {
  id: "env_1",
  name: "Staging",
  slug: "staging",
  description: null,
  isDefault: false,
  isActive: false,
};

describe("environment.update contract", () => {
  it("registers with the correct name", () => {
    expect(environmentUpdate.name).toBe("update_environment");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentUpdate.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input with optional fields", () => {
    expect(() =>
      environmentUpdate.input.parse({
        environmentId: "env_1",
        name: "Staging",
        isActive: false,
      }),
    ).not.toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => environmentUpdate.input.parse({ name: "Staging" })).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      environmentUpdate.output.parse({ environment: summary }),
    ).not.toThrow();
  });
});
