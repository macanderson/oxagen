import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolbeltList, toolbeltListItem } from "./toolbelt.list";

const allTools = {
  id: "tbt_0123456789abcdefghjkmn",
  name: "All tools",
  slug: "all-tools",
  kind: "all_tools",
  description: null,
  clonedFrom: null,
  tools: 12,
  activeTools: 10,
  servers: 3,
  agents: 2,
  updatedAt: "2026-09-25T12:00:00.000Z",
};

describe("list_toolbelts contract", () => {
  it("is a console read on api and mcp that workspace members can make", () => {
    expect(getCapability("list_toolbelts")).toBe(toolbeltList);
    expect(toolbeltList.mutates).toBe(false);
    expect(toolbeltList.surfaces).toEqual(["api", "mcp"]);
    expect(toolbeltList.defaultRoles.workspace).toMatchObject({
      Member: "allow",
    });
  });

  it("carries the All tools belt and a clone that names its source", () => {
    expect(toolbeltListItem.parse(allTools)).toEqual(allTools);
    const clone = {
      ...allTools,
      id: "tbt_1abcdefghjkmnpqrstvwxy",
      name: "Read only",
      slug: "read-only",
      kind: "custom",
      clonedFrom: {
        id: allTools.id,
        name: allTools.name,
        slug: allTools.slug,
        kind: "all_tools",
      },
    };
    expect(toolbeltListItem.parse(clone).clonedFrom?.slug).toBe("all-tools");
    expect(
      toolbeltListItem.safeParse({ ...allTools, kind: "shared" }).success,
    ).toBe(false);
  });

  it("answers with how many tools the workspace made available", () => {
    expect(
      toolbeltList.output.parse({ items: [allTools], availableTools: 0 })
        .availableTools,
    ).toBe(0);
  });
});
