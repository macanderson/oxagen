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
