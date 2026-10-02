import { describe, expect, it } from "vitest";
import { WORK_ITEM_LABELS_MAX, WORK_ITEM_SUBJECT_MAX, workItemCreate as contract } from "./work.item.create";

// create_work_item (P1-03, #5103).
describe("create_work_item contract", () => {
  it("takes a subject and defaults the labels", () => {
    expect(contract.input.parse({ subject: "  Fix invites " })).toEqual({ subject: "Fix invites", labels: [] });
    expect(
      contract.input.parse({ subject: "Fix invites", description: "Steps", labels: ["Bug"], repository: "acme/web" }),
    ).toEqual({ subject: "Fix invites", description: "Steps", labels: ["Bug"], repository: "acme/web" });
  });

  it.each([
    ["an empty subject", { subject: " " }],
    ["a subject over the limit", { subject: "x".repeat(WORK_ITEM_SUBJECT_MAX + 1) }],
    ["too many labels", { subject: "x", labels: Array.from({ length: WORK_ITEM_LABELS_MAX + 1 }, (_, i) => `l${i}`) }],
    ["a repository that is not owner/name", { subject: "x", repository: "acme" }],
    ["a field it does not know", { subject: "x", priority: "P0" }],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it("answers the new item's id, number, state, revision, and version", () => {
    expect(
      contract.output.safeParse({ item_id: "wi_01", number: "WI-1", state: "new", revision: 1, version: 1 }).success,
    ).toBe(true);
    expect(contract.output.safeParse({ item_id: "01", number: "WI-1", state: "new", revision: 1, version: 1 }).success).toBe(false);
  });

  it("writes, stays off the agent surface, and charges no credits", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.noBillingGate).toBe(true);
    expect(contract.surfaces).toEqual(["api", "mcp"]);
  });
});
