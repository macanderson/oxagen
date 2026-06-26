import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { isKnowledgeGraphEnabled } from "./knowledge-graph";

// Store original env vars so we can restore them after each test.
const ORIGINAL_NEO4J_URI = process.env.NEO4J_URI;
const ORIGINAL_KG_FLAG = process.env.KNOWLEDGE_GRAPH_ENABLED;

beforeEach(() => {
  // Start each test in the disabled state by default.
  delete process.env.NEO4J_URI;
  delete process.env.KNOWLEDGE_GRAPH_ENABLED;
});

afterEach(() => {
  // Restore original values so tests don't pollute each other.
  if (ORIGINAL_NEO4J_URI !== undefined) {
    process.env.NEO4J_URI = ORIGINAL_NEO4J_URI;
  } else {
    delete process.env.NEO4J_URI;
  }
  if (ORIGINAL_KG_FLAG !== undefined) {
    process.env.KNOWLEDGE_GRAPH_ENABLED = ORIGINAL_KG_FLAG;
  } else {
    delete process.env.KNOWLEDGE_GRAPH_ENABLED;
  }
});

describe("isKnowledgeGraphEnabled", () => {
  it("returns false when NEO4J_URI is absent", () => {
    delete process.env.NEO4J_URI;
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns false when NEO4J_URI is an empty string", () => {
    process.env.NEO4J_URI = "";
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns false when KNOWLEDGE_GRAPH_ENABLED is 'false' even if NEO4J_URI is set", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.KNOWLEDGE_GRAPH_ENABLED = "false";
    expect(isKnowledgeGraphEnabled()).toBe(false);
  });

  it("returns true when NEO4J_URI is set and the flag is not explicitly false", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    expect(isKnowledgeGraphEnabled()).toBe(true);
  });

  it("returns true when NEO4J_URI is set and KNOWLEDGE_GRAPH_ENABLED is 'true'", () => {
    process.env.NEO4J_URI = "bolt://localhost:7687";
    process.env.KNOWLEDGE_GRAPH_ENABLED = "true";
    expect(isKnowledgeGraphEnabled()).toBe(true);
  });
});
