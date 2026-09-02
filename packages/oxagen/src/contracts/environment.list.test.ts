import { describe, expect, it } from "vitest";
import { environmentList } from "./environment.list";

const summary = {
  id: "env_1",
  name: "Production",
  slug: "production",
  description: null,
  isDefault: true,
  isActive: true,
};

describe("environment.list contract", () => {
  it("registers with the correct name", () => {
    expect(environmentList.name).toBe("list_environments");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentList.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts an empty input object", () => {
    expect(() => environmentList.input.parse({})).not.toThrow();
  });
  it("rejects a non-object input", () => {
    expect(() => environmentList.input.parse(null)).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() =>
      environmentList.output.parse({ environments: [summary] }),
    ).not.toThrow();
    expect(() =>
      environmentList.output.parse({ environments: [] }),
    ).not.toThrow();
  });
});
