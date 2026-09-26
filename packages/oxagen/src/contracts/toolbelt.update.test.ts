import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolbeltChangeSchema, toolbeltUpdate } from "./toolbelt.update";

const BELT_ID = "tbt_0123456789abcdefghjkmn";

describe("update_toolbelt contract", () => {
  it("is a settings write on api and mcp", () => {
    expect(getCapability("update_toolbelt")).toBe(toolbeltUpdate);
    expect(toolbeltUpdate.mutates).toBe(true);
    expect(toolbeltUpdate.surfaces).toEqual(["api", "mcp"]);
  });

  it("defaults to no changes", () => {
    expect(toolbeltUpdate.input.parse({ toolbeltId: BELT_ID })).toEqual({
      toolbeltId: BELT_ID,
      changes: [],
    });
  });

  it("takes the four changes, by server or by tool, a null server meaning the declared tools", () => {
    expect(
      toolbeltChangeSchema.parse({ op: "add_server", serverId: null }),
    ).toEqual({ op: "add_server", serverId: null, active: true });
    for (const change of [
      { op: "remove_server", serverId: "mcs_0123456789abcdefghjkmn" },
      { op: "set_server_active", serverId: null, active: false },
      {
        op: "set_tool_active",
        toolId: "tol_0123456789abcdefghjkmn",
        active: true,
      },
    ]) {
      expect(toolbeltChangeSchema.safeParse(change).success, change.op).toBe(
        true,
      );
    }
  });

  it("refuses an unknown op, a server named by name, and a tool change without a state", () => {
    expect(
      toolbeltChangeSchema.safeParse({ op: "rename_server", serverId: null })
        .success,
    ).toBe(false);
    expect(
      toolbeltChangeSchema.safeParse({
        op: "remove_server",
        serverId: "github",
      }).success,
    ).toBe(false);
    expect(
      toolbeltChangeSchema.safeParse({
        op: "set_tool_active",
        toolId: "tol_0123456789abcdefghjkmn",
      }).success,
    ).toBe(false);
  });
});
