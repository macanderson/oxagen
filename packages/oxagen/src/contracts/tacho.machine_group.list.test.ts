import { describe, expect, it } from "vitest";
import { tachoMachineGroupList } from "./tacho.machine_group.list";

describe("list_machine_groups contract", () => {
  it("is a headless read the workspace's readers may call", () => {
    expect(tachoMachineGroupList.name).toBe("list_machine_groups");
    expect(tachoMachineGroupList.surfaces).toEqual([]);
    expect(tachoMachineGroupList.scoped).toBe(true);
    expect(tachoMachineGroupList.mutates).toBe(false);
    expect(tachoMachineGroupList.noBillingGate).toBe(true);
    expect(tachoMachineGroupList.defaultEffect).toBe("deny");
    expect(tachoMachineGroupList.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
    });
  });

  it("takes an optional group and nothing else", () => {
    expect(tachoMachineGroupList.input.parse({})).toEqual({});
    expect(tachoMachineGroupList.input.parse({ group: "dev-laptops" })).toEqual({
      group: "dev-laptops",
    });
    for (const input of [{ group: "" }, { group: "Dev" }, { workspaceId: "ws_1" }]) {
      expect(tachoMachineGroupList.input.safeParse(input).success).toBe(false);
    }
  });

  it("answers each group with its machines, a revoked one included", () => {
    const listing = {
      groups: [
        {
          group: "dev-laptops",
          machines: [
            {
              machineId: "tch_4q8r1t6v3x5z0b2d7h2k9m",
              hostname: "mac-1",
              status: "revoked",
              addedAt: "2026-09-27T09:00:00.000Z",
            },
          ],
        },
      ],
    };
    expect(tachoMachineGroupList.output.parse(listing)).toEqual(listing);
    const unknownStatus = structuredClone(listing);
    (unknownStatus.groups[0]?.machines[0] as { status: string }).status = "gone";
    expect(tachoMachineGroupList.output.safeParse(unknownStatus).success).toBe(false);
  });
});
