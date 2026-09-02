import { describe, expect, it } from "vitest";
import { environmentDelete } from "./environment.delete";

describe("environment.delete contract", () => {
  it("registers with the correct name", () => {
    expect(environmentDelete.name).toBe("delete_environment");
  });
  it("exposes the api, mcp, and agent surfaces", () => {
    expect(environmentDelete.surfaces).toEqual(["api", "mcp", "agent"]);
  });
  it("accepts a valid input", () => {
    expect(() =>
      environmentDelete.input.parse({ environmentId: "env_1" }),
    ).not.toThrow();
  });
  it("rejects input missing the required environmentId", () => {
    expect(() => environmentDelete.input.parse({})).toThrow();
  });
  it("accepts a valid output", () => {
    expect(() => environmentDelete.output.parse({ ok: true })).not.toThrow();
  });
});
