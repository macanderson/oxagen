import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolbeltDelete } from "./toolbelt.delete";

describe("delete_toolbelt contract", () => {
  it("is a settings write on api and mcp", () => {
    expect(getCapability("delete_toolbelt")).toBe(toolbeltDelete);
    expect(toolbeltDelete.mutates).toBe(true);
    expect(toolbeltDelete.surfaces).toEqual(["api", "mcp"]);
  });

  it("takes a belt by public id and answers that it is deleted", () => {
    const toolbeltId = "tbt_0123456789abcdefghjkmn";
    expect(toolbeltDelete.input.parse({ toolbeltId })).toEqual({ toolbeltId });
    expect(toolbeltDelete.input.safeParse({}).success).toBe(false);
    expect(toolbeltDelete.output.parse({ toolbeltId, deleted: true })).toEqual({
      toolbeltId,
      deleted: true,
    });
    expect(
      toolbeltDelete.output.safeParse({ toolbeltId, deleted: false }).success,
    ).toBe(false);
  });
});
