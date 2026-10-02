import { describe, expect, it } from "vitest";
import { workBriefApprove as contract } from "./work.brief.approve";

const ITEM = "wi_0a1b2c";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const input = {
  item_id: ITEM,
  version: 4,
  item_revision: 1,
  brief_revision: 2,
  brief_digest: DIGEST,
};

// approve_work_brief (agent-work-phase-1.html, Work lifecycle; P1-04, ADR-251).
describe("approve_work_brief contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("approve_work_brief");
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

  it("takes the brief revision and digest the person read", () => {
    expect(contract.input.parse(input)).toEqual(input);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an unknown key", { criteria: [] }],
    ["a digest with no sha256 prefix", { brief_digest: "a".repeat(64) }],
    ["a short digest", { brief_digest: `sha256:${"a".repeat(63)}` }],
    ["brief revision 0", { brief_revision: 0 }],
    ["a version that is not a whole number", { version: 1.5 }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the item after the approval", () => {
    expect(contract.output.safeParse({ item: ITEM_AFTER, repeat: true }).success).toBe(true);
    expect(contract.output.safeParse({ item: { ...ITEM_AFTER, state: "approved" }, repeat: false }).success).toBe(false);
  });
});
