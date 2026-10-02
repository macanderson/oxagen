import { describe, expect, it } from "vitest";
import { workOrderStop as contract } from "./work.order.stop";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const ORDER_AFTER = { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" };
const input = {
  item_id: ITEM,
  version: 6,
  work_order_id: ORDER,
  reason: "The run used the wrong base branch.",
};

// stop_work_order (agent-work-phase-1.html, Delivery and review; P1-04, ADR-250).
describe("stop_work_order contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("stop_work_order");
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

  it("audits the work order", () => {
    expect(contract.audit).toEqual({ targetKind: "work_order", targetIdField: "work_order_id" });
  });

  it("takes the send to stop and the reason", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an id that is not a work order's", { work_order_id: "wi_x" }],
    ["an unknown key", { note: "x" }],
    ["an empty reason", { reason: "" }],
    ["a reason of spaces", { reason: "   " }],
    ["a reason past 2,000 characters", { reason: "r".repeat(2001) }],
    ["a negative version", { version: -1 }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the cancel command, or null when no run is linked yet", () => {
    const answer = { item: { ...ITEM_AFTER, state: "running" }, repeat: false, order: { ...ORDER_AFTER, delivery: "stopping" }, command_id: "tcm_0a1b2c" };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, command_id: null }).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });
});
