import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolbeltGet, toolbeltGroupSchema } from "./toolbelt.get";

describe("get_toolbelt contract", () => {
  it("is a console read on api and mcp", () => {
    expect(getCapability("get_toolbelt")).toBe(toolbeltGet);
    expect(toolbeltGet.mutates).toBe(false);
    expect(toolbeltGet.surfaces).toEqual(["api", "mcp"]);
  });

  it("takes a belt by public id only", () => {
    expect(
      toolbeltGet.input.safeParse({ toolbeltId: "tbt_0123456789abcdefghjkmn" })
        .success,
    ).toBe(true);
    expect(
      toolbeltGet.input.safeParse({ toolbeltId: "all-tools" }).success,
    ).toBe(false);
  });

  it("groups tools under a server, or under the declared tools with a null id", () => {
    const tool = {
      id: "tol_0123456789abcdefghjkmn",
      slug: "github-create-issue",
      name: "create_issue",
      description: null,
      available: true,
      defaultActive: true,
      active: true,
      member: true,
    };
    expect(
      toolbeltGroupSchema.parse({
        server: { id: "mcs_0123456789abcdefghjkmn", name: "github" },
        included: true,
        tools: [tool],
      }).tools,
    ).toHaveLength(1);
    expect(
      toolbeltGroupSchema.parse({
        server: { id: null, name: "Declared tools" },
        included: false,
        tools: [],
      }).server.id,
    ).toBeNull();
    expect(
      toolbeltGroupSchema.safeParse({
        server: { id: "github", name: "github" },
        included: true,
        tools: [],
      }).success,
    ).toBe(false);
  });
});
