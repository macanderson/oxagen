import { describe, expect, it } from "vitest";
import { workCriterionClaim as contract } from "./work.criterion.claim";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const SHA = "a1".repeat(20);
const input = {
  item_id: ITEM,
  work_order_id: ORDER,
  criterion_id: "c2",
  head_sha: SHA,
  text: "The invite test covers the expired link.",
};

// claim_work_criterion: the agent's claim on one criterion of the brief (ADR-244, ADR-251).
describe("claim_work_criterion contract", () => {
  it("registers the agent's claim on the API and MCP surfaces, not the agent surface", () => {
    expect(contract.name).toBe("claim_work_criterion");
    expect(contract.domain).toBe("work");
    expect(contract.surfaces).toEqual(["api", "mcp"]);
    expect(contract.layers).toEqual(["schema", "api", "mcp", "unit", "docs"]);
    expect(contract.scoped).toBe(true);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.mutates).toBe(true);
    expect(contract.sensitivity).toBe("high");
  });

  it("takes the roles claim_work_order takes: the host key's creator is an org Owner or Admin", () => {
    expect(contract.defaultEffect).toBe("deny");
    expect(contract.defaultRoles.org).toEqual({ Owner: "allow", Admin: "allow" });
    expect(contract.defaultRoles.workspace).toEqual({});
  });

  it("audits the work order", () => {
    expect(contract.audit).toEqual({ targetKind: "work_order", targetIdField: "work_order_id" });
  });

  it("takes the item, the send, the criterion, the head commit, and the statement", () => {
    expect(contract.input.parse(input)).toEqual(input);
    expect(contract.input.parse({ ...input, text: "  Covered by a test.  " }).text).toBe("Covered by a test.");
  });

  it.each([
    ["an item id that is not a work item's", { item_id: ORDER }],
    ["an order id that is not a work order's", { work_order_id: ITEM }],
    ["a criterion id with no number", { criterion_id: "c" }],
    ["a criterion id from 0", { criterion_id: "c0" }],
    ["a short head commit", { head_sha: SHA.slice(0, 7) }],
    ["an uppercase head commit", { head_sha: SHA.toUpperCase() }],
    ["an empty statement", { text: "   " }],
    ["a statement over 2000 characters", { text: "a".repeat(2001) }],
    ["an unknown key", { run_id: "tse_abc" }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the item, the send, and the claim with the run it is filed as", () => {
    const answer = {
      item: { id: ITEM, state: "review", revision: 1, version: 9 },
      repeat: false,
      order: { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" },
      claim: { criterion_id: "c2", head_sha: SHA, run_id: "tse_0a1b2c" },
    };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, repeat: true }).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, claim: { ...answer.claim, head_sha: "x" } }).success).toBe(false);
    expect(contract.output.safeParse({ ...answer, accepted: true }).success).toBe(false);
  });
});
