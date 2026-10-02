import { describe, expect, it } from "vitest";
import { workItemReopen as contract } from "./work.item.reopen";

const ITEM = "wi_0a1b2c";
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const input = { item_id: ITEM, version: 8, reason: "The fix broke the export." };

// reopen_work_item (agent-work-phase-1.html, Work lifecycle; P1-04, ADR-251).
describe("reopen_work_item contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("reopen_work_item");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.mutates).toBe(true);
    expect(contract.sensitivity).toBe("high");
  });

  it("lets org Owners and Admins and workspace Owners and Members act, and no Viewer", () => {
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({ Owner: "allow", Admin: "allow" });
    expect(contract.defaultRoles.workspace).toEqual({ Owner: "allow", Member: "allow" });
    expect(contract.defaultRoles.org).not.toHaveProperty("Viewer");
    expect(contract.defaultRoles.workspace).not.toHaveProperty("Viewer");
  });

  it("audits the work item", () => {
    expect(contract.audit).toEqual({ targetKind: "work_item", targetIdField: "item_id" });
  });

  it("takes the item, the version the person read, and the reason", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an unknown key", { resolution: "cancelled" }],
    ["an empty reason", { reason: "" }],
    ["a reason of spaces", { reason: "   " }],
    ["a version that is not a whole number", { version: 2.5 }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the reopened item at its next revision", () => {
    expect(contract.output.safeParse({ item: { ...ITEM_AFTER, state: "triaged", revision: 2 }, repeat: false }).success).toBe(true);
    expect(contract.output.safeParse({ item: { ...ITEM_AFTER, revision: 0 }, repeat: false }).success).toBe(false);
  });
});
