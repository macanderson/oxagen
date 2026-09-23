import { describe, expect, it } from "vitest";
import { costCenterList } from "./cost_center.list";

describe("list_cost_centers contract", () => {
  it("is an organization-level read that takes nothing", () => {
    expect(costCenterList.scoped).toBe(false);
    expect(costCenterList.mutates).toBe(false);
    expect(costCenterList.noBillingGate).toBe(true);
    expect(costCenterList.input.parse({})).toEqual({});
    expect(costCenterList.input.safeParse({ orgId: "x" }).success).toBe(false);
  });

  it("answers labels with their counts", () => {
    const out = {
      costCenters: [
        {
          id: "ccn_1",
          label: "ENG-1001",
          description: null,
          agents: 2,
          workspaces: 0,
          createdAt: "2026-09-22T10:00:00.000Z",
        },
      ],
    };
    expect(costCenterList.output.parse(out)).toEqual(out);
  });
});
