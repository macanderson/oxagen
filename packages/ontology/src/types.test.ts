import { describe, expect, it } from "vitest";
import { NodeLabels, EdgeTypes, VectorIndexes } from "./types.js";

// These tests guard the ontology type registry against accidental drift.
// VectorIndexes is consumed at runtime by the Neo4j client; structural regressions
// here (missing fields, wrong dimensions, duplicate names) would produce silent schema mismatches.

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
    ] as const;

    for (const label of required) {
      expect(NodeLabels).toHaveProperty(label);
      // The value must equal the key (identity labels).
      expect(NodeLabels[label]).toBe(label);
    }
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
      "BRANCHED_TO_SUBAGENT",
      "APPROVED_BY",
    ] as const;

    for (const edge of required) {
      expect(EdgeTypes).toHaveProperty(edge);
      expect(EdgeTypes[edge]).toBe(edge);
    }
  });

  it("has no duplicate values", () => {
    const values = Object.values(EdgeTypes);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

describe("VectorIndexes (@oxagen/ontology)", () => {
  it("has exactly three index definitions", () => {
    expect(VectorIndexes).toHaveLength(3);
  });

  it("every index entry has label, property, name, dimensions, and similarity fields", () => {
    for (const idx of VectorIndexes) {
      expect(typeof idx.label).toBe("string");
      expect(typeof idx.property).toBe("string");
      expect(typeof idx.name).toBe("string");
      expect(typeof idx.dimensions).toBe("number");
      expect(typeof idx.similarity).toBe("string");
    }
  });

  it("all indexes use 1536 dimensions (text-embedding-3-small default)", () => {
    for (const idx of VectorIndexes) {
      expect(idx.dimensions).toBe(1536);
    }
  });

  it("all indexes use cosine similarity", () => {
    for (const idx of VectorIndexes) {
      expect(idx.similarity).toBe("cosine");
    }
  });

  it("covers Document, AgentMemory, and Message embeddings", () => {
    const labels = VectorIndexes.map((i) => i.label);
    expect(labels).toContain("Document");
    expect(labels).toContain("AgentMemory");
    expect(labels).toContain("Message");
  });

  it("all index names are unique", () => {
    const names = VectorIndexes.map((i) => i.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("every index property is 'embedding'", () => {
    for (const idx of VectorIndexes) {
      expect(idx.property).toBe("embedding");
    }
  });
});
