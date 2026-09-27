import { describe, expect, it } from "vitest";
import { tachoMachineGroupRemove } from "./tacho.machine_group.remove";

const MACHINE = "tch_4q8r1t6v3x5z0b2d7h2k9m";

describe("remove_group_machine contract", () => {
  it("is a headless, high-sensitivity write for org Owner and Admin", () => {
    expect(tachoMachineGroupRemove.name).toBe("remove_group_machine");
    expect(tachoMachineGroupRemove.surfaces).toEqual([]);
    expect(tachoMachineGroupRemove.scoped).toBe(true);
    expect(tachoMachineGroupRemove.mutates).toBe(true);
    expect(tachoMachineGroupRemove.noBillingGate).toBe(true);
    expect(tachoMachineGroupRemove.sensitivity).toBe("high");
    expect(tachoMachineGroupRemove.defaultEffect).toBe("deny");
    expect(tachoMachineGroupRemove.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a group and a machine enrollment id and nothing else", () => {
    expect(
      tachoMachineGroupRemove.input.parse({ group: "ci-runners", machineId: MACHINE }),
    ).toEqual({ group: "ci-runners", machineId: MACHINE });
    const bad = [
      {},
      { group: "ci-runners" },
      { group: "CI", machineId: MACHINE },
      { group: "ci-runners", machineId: "tch_short" },
      { group: "ci-runners", machineId: MACHINE, orgId: "org_1" },
    ];
    for (const input of bad) {
      expect(tachoMachineGroupRemove.input.safeParse(input).success).toBe(false);
    }
  });

  it("answers whether a membership was removed", () => {
    const receipt = { group: "ci-runners", machineId: MACHINE, removed: false };
    expect(tachoMachineGroupRemove.output.parse(receipt)).toEqual(receipt);
    expect(
      tachoMachineGroupRemove.output.safeParse({ group: "ci-runners", machineId: MACHINE })
        .success,
    ).toBe(false);
  });
});
