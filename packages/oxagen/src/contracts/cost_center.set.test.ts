import { describe, expect, it } from "vitest";
import { costCenterSet } from "./cost_center.set";

describe("set_cost_center contract", () => {
  it("is workspace-scoped and sets or clears the workspace's label", () => {
    expect(costCenterSet.scoped).toBe(true);
    expect(
      costCenterSet.input.parse({
        target: "workspace",
        costCenter: "ENG-1001",
      }),
    ).toEqual({ target: "workspace", costCenter: "ENG-1001" });
    expect(
      costCenterSet.input.parse({ target: "workspace", costCenter: null }),
    ).toEqual({ target: "workspace", costCenter: null });
  });

  it("names a workspace target by public id, and refuses any other id", () => {
    expect(
      costCenterSet.input.parse({
        target: "workspace",
        workspace: "wrk_0a1b2c3d4e5f6g7h8j9k0m",
        costCenter: "ENG-1001",
      }),
    ).toMatchObject({ workspace: "wrk_0a1b2c3d4e5f6g7h8j9k0m" });
    expect(
      costCenterSet.input.safeParse({
        target: "workspace",
        workspace: "core-platform",
        costCenter: null,
      }).success,
    ).toBe(false);
  });

  it("requires an agent target to name the agent", () => {
    expect(
      costCenterSet.input.safeParse({ target: "agent", costCenter: "ENG-1001" })
        .success,
    ).toBe(false);
    expect(
      costCenterSet.input.safeParse({
        target: "agent",
        agent: "reviewer",
        costCenter: "ENG-1001",
      }).success,
    ).toBe(true);
  });
});
