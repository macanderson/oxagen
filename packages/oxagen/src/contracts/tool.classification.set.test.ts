/**
 * Contract test for set_tool_classification (#2958).
 */
import { describe, expect, it } from "vitest";
import { getCapability } from "../registry";
import { toolClassificationSet } from "./tool.classification.set";

const classification = {
  sideEffect: "write",
  egress: "third_party",
  consequenceTags: ["communicates_externally"],
  measures: { recipients: { path: "$.to", type: "count", unit: "recipients" } },
  dataClasses: [],
};

describe("set_tool_classification is registered as declared", () => {
  it("is scoped, mutates=true and is never a governed action", () => {
    const cap = getCapability("set_tool_classification");
    expect(cap).toBeDefined();
    expect(cap?.scoped).toBe(true);
    expect(cap?.mutates).toBe(true);
    expect(cap?.noBillingGate).toBe(true);
  });
});

describe("set_tool_classification", () => {
  it("names the version as the audit target", () => {
    expect(toolClassificationSet.audit).toEqual({
      targetKind: "tool_version",
      targetIdField: "toolVersionId",
    });
  });

  it("parses a full classification with a reason", () => {
    const parsed = toolClassificationSet.input.parse({
      toolVersionId: "tlv_1",
      riskGrade: "high",
      classification,
      reason: "sends mail to customers",
    });
    expect(parsed.classification.consequenceTags).toEqual([
      "communicates_externally",
    ]);
  });

  it("refuses an empty reason", () => {
    expect(
      toolClassificationSet.input.safeParse({
        toolVersionId: "tlv_1",
        riskGrade: "high",
        classification,
        reason: "  ",
      }).success,
    ).toBe(false);
  });
});
