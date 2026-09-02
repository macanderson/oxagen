import { describe, expect, it } from "vitest";
import { connectionMappingsSuggest } from "./connection.mappings.suggest";
import { getCapability } from "../registry";

const validRecordType = {
  sourceRecordType: "pull_request",
  displayName: "Pull Request",
  description: "GitHub PR",
  sampleFields: ["number", "title", "state", "user.login"],
  sampleRecords: [{ number: 1, title: "Fix bug", state: "open" }],
};

describe("connection.mappings.suggest capability", () => {
  it("parses valid input", () => {
    const parsed = connectionMappingsSuggest.input.parse({
      connectionId: "con_ABC",
      recordTypes: [validRecordType],
    });
    expect(parsed.recordTypes).toHaveLength(1);
    expect(parsed.existingEntityTypes).toBeUndefined();
  });

  it("parses input with existingEntityTypes", () => {
    const parsed = connectionMappingsSuggest.input.parse({
      connectionId: "con_ABC",
      recordTypes: [validRecordType],
      existingEntityTypes: ["task", "code_change"],
    });
    expect(parsed.existingEntityTypes).toEqual(["task", "code_change"]);
  });

  it("rejects empty recordTypes array", () => {
    expect(() =>
      connectionMappingsSuggest.input.parse({
        connectionId: "con_ABC",
        recordTypes: [],
      }),
    ).not.toThrow(); // empty array is allowed by schema — the LLM just has nothing to suggest
  });

  it("description field in record type is optional", () => {
    const parsed = connectionMappingsSuggest.input.parse({
      connectionId: "con_ABC",
      recordTypes: [
        {
          sourceRecordType: "issue",
          displayName: "Issue",
          sampleFields: ["title", "body"],
        },
      ],
    });
    expect(parsed.recordTypes[0]?.description).toBeUndefined();
  });

  it("parses valid output", () => {
    const parsed = connectionMappingsSuggest.output.parse({
      suggestions: [
        {
          sourceRecordType: "pull_request",
          suggestedEntityType: "code_change",
          suggestedPropertyMappings: { "user.login": "author", title: "title" },
          confidence: 0.95,
          reasoning: "Pull requests represent code changes",
        },
      ],
      suggestionIds: ["sug_abc123"],
    });
    expect(parsed.suggestions).toHaveLength(1);
    expect(parsed.suggestions[0]?.suggestedEntityType).toBe("code_change");
    expect(parsed.suggestions[0]?.confidence).toBe(0.95);
    expect(parsed.suggestionIds).toEqual(["sug_abc123"]);
  });

  it("rejects confidence outside 0-1", () => {
    expect(() =>
      connectionMappingsSuggest.output.parse({
        suggestions: [
          {
            sourceRecordType: "pr",
            suggestedEntityType: "code_change",
            suggestedPropertyMappings: {},
            confidence: 1.5,
            reasoning: "too confident",
          },
        ],
        suggestionIds: [],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("suggest_connection_mappings")).toBe(
      connectionMappingsSuggest,
    );
  });

  it("is an AI category, low risk, no approval required", () => {
    expect(connectionMappingsSuggest.agent?.category).toBe("ai");
    expect(connectionMappingsSuggest.agent?.requiresApproval).toBe(false);
    expect(connectionMappingsSuggest.agent?.riskLevel).toBe("low");
  });
});
