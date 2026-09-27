import { describe, expect, it } from "vitest";
import { tachoMachineGroupAdd } from "./tacho.machine_group.add";

const MACHINE = "tch_4q8r1t6v3x5z0b2d7h2k9m";

describe("add_group_machine contract", () => {
  it("is a headless, high-sensitivity write for org Owner and Admin", () => {
    expect(tachoMachineGroupAdd.name).toBe("add_group_machine");
    expect(tachoMachineGroupAdd.surfaces).toEqual([]);
    expect(tachoMachineGroupAdd.scoped).toBe(true);
    expect(tachoMachineGroupAdd.mutates).toBe(true);
    expect(tachoMachineGroupAdd.noBillingGate).toBe(true);
    expect(tachoMachineGroupAdd.sensitivity).toBe("high");
    expect(tachoMachineGroupAdd.defaultEffect).toBe("deny");
    expect(tachoMachineGroupAdd.defaultRoles).toEqual({
      org: { Owner: "allow", Admin: "allow" },
      workspace: {},
    });
  });

  it("takes a group and a machine enrollment id and nothing else", () => {
    expect(
      tachoMachineGroupAdd.input.parse({ group: "dev-laptops", machineId: MACHINE }),
    ).toEqual({ group: "dev-laptops", machineId: MACHINE });
    const bad = [
      {},
      { group: "dev-laptops" },
      { machineId: MACHINE },
      { group: "Dev-Laptops", machineId: MACHINE },
      { group: "-laptops", machineId: MACHINE },
      { group: "a".repeat(64), machineId: MACHINE },
      { group: "dev_laptops", machineId: MACHINE },
      { group: "dev-laptops", machineId: "laptop-1" },
      { group: "dev-laptops", machineId: MACHINE, workspaceId: "ws_1" },
    ];
    for (const input of bad) {
      expect(tachoMachineGroupAdd.input.safeParse(input).success).toBe(false);
    }
  });

  it("accepts a 63-character group, the longest the CHECK allows", () => {
    const group = `a${"b".repeat(62)}`;
    expect(
      tachoMachineGroupAdd.input.safeParse({ group, machineId: MACHINE }).success,
    ).toBe(true);
  });

  it("answers whether the machine joined, with when it joined", () => {
    const receipt = {
      group: "dev-laptops",
      machineId: MACHINE,
      addedAt: "2026-09-27T09:00:00.000Z",
      added: false,
    };
    expect(tachoMachineGroupAdd.output.parse(receipt)).toEqual(receipt);
    expect(
      tachoMachineGroupAdd.output.safeParse({ ...receipt, addedAt: "yesterday" })
        .success,
    ).toBe(false);
  });
});
