import { describe, expect, it } from "vitest";
import { NodeLabels, EdgeTypes } from "./types";

// These tests guard the ontology type registry against accidental drift.

describe("NodeLabels (@oxagen/ontology)", () => {
  it("exports every expected label constant", () => {
    const required = [
      "Tenant",
      "Workspace",
      "User",
      "Agent",
      "AgentVersion",
      "Tool",
      "ToolVersion",
      "Playbook",
      "PlaybookVersion",
      "Execution",
      "Document",
      "AgentMemory",
      "Conversation",
      "Message",
      "Skill",
      "SkillVersion",
      "BackgroundTask",
      "Plan",
      "SubagentFanout",
      "SubagentRun",
      "ContextManifest",
    ] as const;

    for (const label of required) {
      expect(NodeLabels).toHaveProperty(label);
      // The value must equal the key (identity labels).
      expect(NodeLabels[label]).toBe(label);
    }
  });

  it("omits the unused message-based Fanout label", () => {
    expect(NodeLabels).not.toHaveProperty("Fanout");
  });

  it("has no duplicate values", () => {
    const values = Object.values(NodeLabels);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe("EdgeTypes (@oxagen/ontology)", () => {
  it("exports every expected edge type", () => {
    const required = [
      "OWNS",
      "MEMBER_OF",
      "USES_TOOL",
      "EXECUTED",
      "PRODUCED",
      "DERIVED_FROM",
      "TRIGGERED_BY",
      "TRIGGERED",
      "REFERENCES",
      "REMEMBERS",
      "SIMILAR_TO",
      "REPLIES_TO",
      "BRANCHED_FROM",
      "CONTAINS",
      "INVOKED",
      "LOADED_SKILL",
      "APPROVED_BY",
      "DISPATCHED",
      "SPAWNED_FANOUT",
      "USED_CONTEXT",
    ] as const;

    for (const edge of required) {
      expect(EdgeTypes).toHaveProperty(edge);
      expect(EdgeTypes[edge]).toBe(edge);
    }
  });

  it("omits the unused message-based fanout edge types", () => {
    expect(EdgeTypes).not.toHaveProperty("BRANCHED_TO_SUBAGENT");
    expect(EdgeTypes).not.toHaveProperty("ORIGINATED_FROM");
  });

  it("has no duplicate values", () => {
    const values = Object.values(EdgeTypes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});
