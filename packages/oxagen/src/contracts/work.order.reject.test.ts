import { describe, expect, it } from "vitest";
import { workOrderReject as contract } from "./work.order.reject";

const ORDER = "wo_3d4e5f";
const HOST = "tch_0123456789abcdefghjkmn";
const input = { host_enrollment_id: HOST, work_order_id: ORDER, reason: "Claude Code is signed out on this machine." };

// reject_work_order: an enrolled host refuses an order it cannot start (P1-04, ADR-250).
describe("reject_work_order contract", () => {
  it("registers a host's call on the API surface alone", () => {
    expect(contract.name).toBe("reject_work_order");
    expect(contract.surfaces).toEqual(["api"]);
    expect(contract.scoped).toBe(true);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.mutates).toBe(true);
    expect(contract.sensitivity).toBe("high");
  });

  it("needs a key whose creator is an org Owner or Admin, and grants no workspace role", () => {
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({ Owner: "allow", Admin: "allow" });
    expect(contract.defaultRoles.workspace).toEqual({});
  });

  it("audits the work order", () => {
    expect(contract.audit).toEqual({ targetKind: "work_order", targetIdField: "work_order_id" });
  });

  it("takes the host enrollment, the work order, and the reason", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an enrollment id that is not a host's", { host_enrollment_id: "tch_short" }],
    ["an id that is not a work order's", { work_order_id: "wi_x" }],
    ["an unknown key", { run_id: "tse_1" }],
    ["an empty reason", { reason: "" }],
    ["a reason of spaces", { reason: "   " }],
    ["a reason past 512 characters", { reason: "r".repeat(513) }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers whether the order was already rejected", () => {
    expect(contract.output.safeParse({ repeat: true }).success).toBe(true);
    expect(contract.output.safeParse({ repeat: false, extra: 1 }).success).toBe(false);
  });
});
