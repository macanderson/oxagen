import { describe, expect, it } from "vitest";
import { workOrderClaim as contract } from "./work.order.claim";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const AGENT = "agt_6g7h8j";
const HOST = "tch_0123456789abcdefghjkmn";
const input = { host_enrollment_id: HOST, work_order_id: ORDER };

// claim_work_order: an enrolled host's claim before it starts a run (P1-04, ADR-250).
describe("claim_work_order contract", () => {
  it("registers a host's call on the API surface alone", () => {
    expect(contract.name).toBe("claim_work_order");
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

  it("takes the host enrollment and the work order", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an enrollment id that is not a host's", { host_enrollment_id: "tch_short" }],
    ["an agent id for the enrollment", { host_enrollment_id: AGENT }],
    ["an id that is not a work order's", { work_order_id: "wi_x" }],
    ["an unknown key", { agent_id: AGENT }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the order and the first prompt of the run", () => {
    const answer = {
      repeat: false,
      work_order: {
        id: ORDER,
        key: `${ITEM}:r1:s1`,
        send: 1,
        item_id: ITEM,
        item_number: "acme/platform#612",
        brief_revision: 1,
        repository: "acme/platform",
        agent_id: AGENT,
        harness: "claude-code",
      },
      prompt: "Brief revision 1 for acme/platform#612.",
    };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, work_order: { ...answer.work_order, item_id: "wo_x" } }).success).toBe(false);
    expect(contract.output.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });
});
