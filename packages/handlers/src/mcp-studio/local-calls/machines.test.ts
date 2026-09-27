// machines.test.ts: a machine runs a local server only when one of its
// groups is in the server's source.machines.
import { describe, expect, it, vi } from "vitest";
import { checkMachine, machineGroupRefusal } from "./machines";
import { MACHINE, SCOPE, readerOf } from "./test-support";

describe("machineGroupRefusal", () => {
  it("allows a machine in one of the server's groups", () => {
    expect(machineGroupRefusal(["dev-laptops", "ci-runners"], ["ci-runners"])).toBeUndefined();
  });

  it("refuses a machine outside the group with the spec's words", () => {
    expect(machineGroupRefusal(["dev-laptops"], ["ci-runners"])).toEqual({
      code: "not_in_group",
      message: "This machine is not in group dev-laptops.",
      fix: "Ask a workspace admin to add it.",
    });
  });

  it("names every group the server allows", () => {
    expect(machineGroupRefusal(["dev-laptops", "ci-runners"], [])?.message).toBe(
      "This machine is not in group dev-laptops or ci-runners.",
    );
  });
});

describe("checkMachine", () => {
  it("reads the machine's groups in the scope and allows a member", async () => {
    const reader = readerOf({ [MACHINE]: ["dev-laptops"] });
    const groupsOf = vi.spyOn(reader, "groupsOf");
    await expect(checkMachine(reader, SCOPE, MACHINE, ["dev-laptops"])).resolves.toBeUndefined();
    expect(groupsOf).toHaveBeenCalledWith(SCOPE, MACHINE);
  });

  it("refuses a machine outside the group", async () => {
    const refusal = await checkMachine(readerOf({}), SCOPE, MACHINE, ["dev-laptops"]);
    expect(refusal?.code).toBe("not_in_group");
  });

  it("refuses every machine when the server names no groups, without reading any", async () => {
    const reader = readerOf({ [MACHINE]: ["dev-laptops"] });
    const groupsOf = vi.spyOn(reader, "groupsOf");
    const refusal = await checkMachine(reader, SCOPE, MACHINE, []);
    expect(refusal?.message).toBe("This machine is not in group (none).");
    expect(groupsOf).not.toHaveBeenCalled();
  });
});
