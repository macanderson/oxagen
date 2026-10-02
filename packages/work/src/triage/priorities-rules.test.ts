import { describe, expect, it } from "vitest";
import { PRIORITIES } from "./fixtures/triage-fixtures";
import { priorityCites, priorityRuleNumbers, priorityRules } from "./priorities-rules";

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

describe("priorityRules", () => {
  it("reads each rule's text, with its continuation lines joined", () => {
    const rules = priorityRules(PRIORITIES.body);
    expect(rules.map((rule) => rule.number)).toEqual(priorityRuleNumbers(PRIORITIES.body));
    expect(rules[1]).toEqual({
      number: 2,
      text: "A defect a paying customer reported ranks one level above the same defect found by us.",
    });
  });

  it("keeps a repeated number's first text, and ends a rule at a blank line", () => {
    const body = ["Intro line.", "2. Second.", "1. First,", "   continued.", "", "Notes after.", "2. Again."].join("\n");
    expect(priorityRules(body)).toEqual([
      { number: 1, text: "First, continued." },
      { number: 2, text: "Second." },
    ]);
  });
});
