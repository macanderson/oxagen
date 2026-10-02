import { describe, expect, it } from "vitest";
import { workOrderSend as contract } from "./work.order.send";

const ITEM = "wi_0a1b2c";
const ORDER = "wo_3d4e5f";
const AGENT = "agt_6g7h8j";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const ORDER_AFTER = { id: ORDER, send: 1, key: `${ITEM}:r1:s1`, delivery: "run_ended" };
const input = {
  item_id: ITEM,
  version: 5,
  item_revision: 1,
  brief_revision: 2,
  brief_digest: DIGEST,
  agent_id: AGENT,
  key: `${ITEM}:r2:s1`,
};

// send_work_order (agent-work-phase-1.html, Delivery and review; P1-04, ADR-250).
describe("send_work_order contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("send_work_order");
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

  it("takes a key that names the item, the brief revision, and the send", () => {
    expect(contract.input.safeParse({ ...input, key: `${ITEM}:r12:s30` }).success).toBe(true);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an id that is not an agent's", { agent_id: "agent_x" }],
    ["an unknown key", { runtime_id: "rt_1" }],
    ["a key with no send", { key: `${ITEM}:r2` }],
    ["a key for brief revision 0", { key: `${ITEM}:r0:s1` }],
    ["a key for send 0", { key: `${ITEM}:r2:s0` }],
    ["a key that names a work order", { key: `${ORDER}:r2:s1` }],
    ["a key with spaces", { key: ` ${ITEM}:r2:s1` }],
    ["a digest with no sha256 prefix", { brief_digest: "a".repeat(64) }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the send, its queued command, and the target the server read", () => {
    const answer = {
      item: { ...ITEM_AFTER, state: "sent" },
      repeat: false,
      order: { ...ORDER_AFTER, delivery: "waiting_for_claim" },
      command_id: "tcm_0a1b2c",
      target: { agent_id: AGENT, runtime_id: "rt_0a1b2c", host_id: "tch_0123456789abcdefghjkmn", runtime_tier: "harness", mandate_id: null },
    };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, target: { ...answer.target, runtime_tier: "cloud" } }).success).toBe(false);
    expect(contract.output.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });
});
