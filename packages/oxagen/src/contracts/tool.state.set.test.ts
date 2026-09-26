import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolStateSet } from "./tool.state.set";

const TOOL = "tol_0123456789abcdefghjkmn";

describe("set_tool_state contract", () => {
  it("is a high-sensitivity settings write on api and mcp", () => {
    expect(getCapability("set_tool_state")).toBe(toolStateSet);
    expect(toolStateSet.mutates).toBe(true);
    expect(toolStateSet.sensitivity).toBe("high");
    expect(toolStateSet.surfaces).toEqual(["api", "mcp"]);
  });

  it("targets a list of tools or one server, the declared tools as null", () => {
    expect(
      toolStateSet.input.safeParse({ toolIds: [TOOL], available: false })
        .success,
    ).toBe(true);
    expect(
      toolStateSet.input.safeParse({ serverId: null, defaultActive: false })
        .success,
    ).toBe(true);
  });

  it("refuses both targets, neither target, and a call that sets nothing", () => {
    expect(
      toolStateSet.input.safeParse({
        toolIds: [TOOL],
        serverId: null,
        available: true,
      }).success,
    ).toBe(false);
    expect(toolStateSet.input.safeParse({ available: true }).success).toBe(
      false,
    );
    expect(toolStateSet.input.safeParse({ toolIds: [TOOL] }).success).toBe(
      false,
    );
    expect(
      toolStateSet.input.safeParse({ toolIds: [], available: true }).success,
    ).toBe(false);
  });
});
