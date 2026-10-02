import { describe, expect, it } from "vitest";
import { PRIORITIES } from "./fixtures/triage-fixtures";
import { priorityCites, priorityRuleNumbers } from "./priorities-rules";

describe("priorityRuleNumbers", () => {
  it("reads the six rules of the spec's priorities record", () => {
    expect(priorityRuleNumbers(PRIORITIES.body)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads only numbers that open a line, each once, in numeric order", () => {
    const body = [
      "Rank by rule 2. Cite it.",
      "10. Tenth rule.",
      "1. First rule.",
      "   2. An indented line continues rule 1.",
      "3.No space, so not a rule.",
      "9. Ninth rule.",
      "1. A repeat of rule 1.",
    ].join("\n");
    expect(priorityRuleNumbers(body)).toEqual([1, 9, 10]);
  });

  it("reads no rules from a body without numbered lines", () => {
    expect(priorityRuleNumbers("Give every work item one Priority label.")).toEqual([]);
  });
});

describe("priorityCites", () => {
  it("names each rule as the lineage and its number", () => {
    expect(priorityCites(PRIORITIES)).toEqual([
      "aintel.work.priorities#1",
      "aintel.work.priorities#2",
      "aintel.work.priorities#3",
      "aintel.work.priorities#4",
      "aintel.work.priorities#5",
      "aintel.work.priorities#6",
    ]);
  });
});
