import { describe, expect, it } from "vitest";
import { workOrderAccept as contract } from "./work.order.accept";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const DIGEST = `sha256:${"a".repeat(64)}`;
const HEAD = "a1".repeat(20);
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const ORDER_AFTER = { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" };
const input = {
  item_id: ITEM,
  version: 9,
  work_order_id: ORDER,
  head_sha: HEAD,
  brief_digest: DIGEST,
  criteria: ["c1", "c2"],
};

// accept_work_order (agent-work-phase-1.html, Delivery and review; P1-04, ADR-250).
describe("accept_work_order contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("accept_work_order");
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

  it("takes the head commit, the brief digest, and the ticked criteria", () => {
    expect(contract.input.parse(input)).toEqual(input);
    // The store refuses a brief with an unticked criterion, not the contract.
    expect(contract.input.safeParse({ ...input, criteria: [] }).success).toBe(true);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an id that is not a work order's", { work_order_id: "wi_x" }],
    ["an unknown key", { required_checks: [] }],
    ["a 39-character head commit", { head_sha: "a".repeat(39) }],
    ["a head commit in uppercase", { head_sha: "A1".repeat(20) }],
    ["a criterion id like x1", { criteria: ["x1"] }],
    ["criterion c0", { criteria: ["c0"] }],
    ["more than 40 criteria", { criteria: Array.from({ length: 41 }, (_, i) => `c${i + 1}`) }],
    ["a digest with no sha256 prefix", { brief_digest: "a".repeat(64) }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the required checks it read on the head, empty when none", () => {
    const answer = { item: { ...ITEM_AFTER, state: "review" }, repeat: false, order: ORDER_AFTER, required_checks: ["ci / unit"] };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, required_checks: [] }).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, required_checks: null }).success).toBe(false);
  });
});
