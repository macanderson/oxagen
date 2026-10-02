import { describe, expect, it } from "vitest";
import { workItemClose as contract } from "./work.item.close";

const ITEM = "wi_0a1b2c";
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const input = {
  item_id: ITEM,
  version: 2,
  resolution: "duplicate",
  reason: "The same fix is in another item.",
};

// close_work_item (agent-work-phase-1.html, Work lifecycle; P1-04, ADR-251).
describe("close_work_item contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("close_work_item");
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

  it.each(["cancelled", "declined", "duplicate"] as const)("takes the %s resolution", (resolution) => {
    expect(contract.input.parse({ ...input, resolution }).resolution).toBe(resolution);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an unknown key", { work_order_id: "wo_x" }],
    ["a resolution that finishes the work", { resolution: "done" }],
    ["an empty reason", { reason: "" }],
    ["a reason of spaces", { reason: "   " }],
    ["a negative version", { version: -1 }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the closed item", () => {
    expect(contract.output.safeParse({ item: { ...ITEM_AFTER, state: "closed" }, repeat: false }).success).toBe(true);
    expect(contract.output.safeParse({ item: { ...ITEM_AFTER, state: "closed" }, repeat: false, extra: 1 }).success).toBe(false);
  });
});
