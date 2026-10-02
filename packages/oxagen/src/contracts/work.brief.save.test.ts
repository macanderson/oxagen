import { describe, expect, it } from "vitest";
import { workBriefSave as contract } from "./work.brief.save";

const ITEM = "wi_0a1b2c";
const DIGEST = `sha256:${"a".repeat(64)}`;
const ITEM_AFTER = { id: ITEM, state: "ready", revision: 1, version: 4 };
const input = {
  item_id: ITEM,
  version: 3,
  item_revision: 1,
  repository: "acme/platform",
  criteria: [
    { id: "c1", text: "The settings page saves the new name.", tag: "code", intent: "check", provenance: "source" },
    { text: "A test covers the empty name.", tag: "test", intent: "review", evidence: "the test file", provenance: "person" },
  ],
};

// save_work_brief (agent-work-phase-1.html, Data contract; P1-04, ADR-251).
describe("save_work_brief contract", () => {
  it("registers a person's work action on the API surface alone", () => {
    expect(contract.name).toBe("save_work_brief");
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

  it("takes a brief whose new criterion has no id, and keeps an earlier criterion's id", () => {
    const parsed = contract.input.parse(input);
    expect(parsed.criteria[0]?.id).toBe("c1");
    expect(parsed.criteria[1]?.id).toBeUndefined();
  });

  it.each([
    ["a criterion id that is not cN", { id: "x1" }],
    ["criterion c0", { id: "c0" }],
    ["an empty criterion", { text: "  " }],
    ["an unknown tag", { tag: "design" }],
    ["an unknown intent", { intent: "approve" }],
    ["an unknown provenance", { provenance: "agent" }],
    ["an unknown criterion key", { weight: 2 }],
  ] as const)("refuses %s", (_name, patch) => {
    const criteria = [{ ...input.criteria[0], ...patch }];
    expect(contract.input.safeParse({ ...input, criteria }).success).toBe(false);
  });

  it.each([
    ["an id that is not a work item's", { item_id: "wo_x" }],
    ["an unknown key", { note: "x" }],
    ["a brief with no criteria", { criteria: [] }],
    ["more than 40 criteria", { criteria: Array.from({ length: 41 }, () => input.criteria[1]) }],
    ["a repository shorter than owner/name", { repository: "ab" }],
    ["item revision 0", { item_revision: 0 }],
    ["a negative version", { version: -1 }],
  ] as const)("refuses %s", (_name, patch) => {
    expect(contract.input.safeParse({ ...input, ...patch }).success).toBe(false);
  });

  it("answers the item and the new brief revision with its digest", () => {
    const answer = { item: ITEM_AFTER, repeat: false, brief: { revision: 2, digest: DIGEST } };
    expect(contract.output.safeParse(answer).success).toBe(true);
    expect(contract.output.safeParse({ ...answer, brief: { revision: 2, digest: "sha256:x" } }).success).toBe(false);
    expect(contract.output.safeParse({ ...answer, extra: 1 }).success).toBe(false);
  });
});
