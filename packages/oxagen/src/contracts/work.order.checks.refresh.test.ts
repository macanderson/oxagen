import { describe, expect, it } from "vitest";
import { workOrderChecksRefresh as contract } from "./work.order.checks.refresh";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const HEAD = "a1".repeat(20);
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const input = { item_id: ITEM, work_order_id: ORDER };

// refresh_work_order_checks (agent-work-phase-1.html, Delivery and review; P1-04, ADR-250).
describe("refresh_work_order_checks contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("refresh_work_order_checks");
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

  it("takes the item and the send, and no version", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an id that is not a work order's", { work_order_id: "wi_x" }],
    ["a version, which the read does not take", { version: 3 }],
    ["a head commit from the caller", { head_sha: HEAD }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the head and its required checks, or why they could not be read", () => {
    const answer = { item: ITEM_AFTER, repeat: false, head_sha: HEAD, required_checks: ["ci / unit"], unread_reason: null };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(
      contract.output.safeParse({ ...answer, required_checks: null, unread_reason: "GitHub answered 403." }).success,
    ).toBe(true);
    expect(
      contract.output.safeParse({ ...answer, head_sha: null, required_checks: null, unread_reason: "No pull request yet." }).success,
    ).toBe(true);
    expect(contract.output.safeParse({ ...answer, head_sha: "a".repeat(39) }).success).toBe(false);
  });
});
