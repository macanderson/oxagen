import { describe, expect, it } from "vitest";
import { reviseRequestProblem, workTriageRevise as contract } from "./work.triage.revise";

// revise_work_triage (P1-03, #5103).
describe("revise_work_triage contract", () => {
  const base = { item_id: "wi_01", expected_version: 4, reason: "A paying customer" };

  it("takes a value to set, or null to clear", () => {
    expect(contract.input.parse({ ...base, priority: "P0" }).priority).toBe("P0");
    expect(contract.input.parse({ ...base, priority: null }).priority).toBeNull();
    expect(contract.input.parse({ ...base, criteria: ["A test passes."] }).criteria).toEqual(["A test passes."]);
    expect(contract.input.parse({ ...base, outcome: null }).outcome).toBeNull();
  });

  it.each([
    ["no reason", { item_id: "wi_01", expected_version: 4, priority: "P0" }],
    ["a priority outside P0 to P3", { ...base, priority: "P4" }],
    ["a negative estimate", { ...base, estimate_minutes: -1 }],
    ["empty acceptance criteria", { ...base, criteria: [] }],
    ["an outcome triage does not use", { ...base, outcome: "closed" }],
    ["a duplicate that is not a work item id", { ...base, outcome: "duplicate", duplicate_of: "tri_01" }],
  ])("refuses %s", (_name, input) => {
    expect(contract.input.safeParse(input).success).toBe(false);
  });

  it.each([
    ["nothing to change", base, "Change at least one field, or the outcome."],
    ["a duplicate outcome with no item", { ...base, outcome: "duplicate" }, "Name the item this one repeats in duplicate_of."],
    ["a duplicate named without that outcome", { ...base, priority: "P1", duplicate_of: "wi_02" }, "Name a duplicate only with the outcome duplicate."],
    ["an item that repeats itself", { ...base, outcome: "duplicate", duplicate_of: "wi_01" }, "An item cannot repeat itself."],
  ])("names the problem with %s", (_name, input, problem) => {
    expect(reviseRequestProblem(contract.input.parse(input))).toBe(problem);
  });

  it("accepts a request it can apply", () => {
    expect(reviseRequestProblem(contract.input.parse({ ...base, outcome: "duplicate", duplicate_of: "wi_02" }))).toBeNull();
    expect(reviseRequestProblem(contract.input.parse({ ...base, labels: null }))).toBeNull();
  });

  it("writes and stays off the agent surface", () => {
    expect(contract.mutates).toBe(true);
    expect(contract.surfaces).not.toContain("agent");
  });
});
