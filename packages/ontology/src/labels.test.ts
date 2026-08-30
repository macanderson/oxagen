import { describe, it, expect } from "vitest";
import {
  ANCHOR_LABEL,
  isValidLabel,
  assertValidLabel,
  sanitizeLabel,
  toLabelKey,
  sanitizeRelationshipType,
  FALLBACK_RELATIONSHIP_TYPE,
} from "./labels";

describe("ANCHOR_LABEL", () => {
  it("is the neutral GraphNode anchor", () => {
    expect(ANCHOR_LABEL).toBe("GraphNode");
  });
});

describe("isValidLabel", () => {
  it("accepts identifier-shaped labels", () => {
    expect(isValidLabel("Submarine")).toBe(true);
    expect(isValidLabel("Execution")).toBe(true);
    expect(isValidLabel("pull_request")).toBe(true);
    expect(isValidLabel("A1_b2")).toBe(true);
  });

  it("rejects empty, leading-digit, and metacharacter labels", () => {
    expect(isValidLabel("")).toBe(false);
    expect(isValidLabel("3D")).toBe(false);
    expect(isValidLabel("has space")).toBe(false);
    expect(isValidLabel("a:b")).toBe(false);
    expect(isValidLabel("a`b")).toBe(false);
    expect(isValidLabel("a)-[r]->(b")).toBe(false);
    expect(isValidLabel("a-b")).toBe(false);
  });

  it("rejects labels longer than 99 chars", () => {
    expect(isValidLabel("A".repeat(99))).toBe(true);
    expect(isValidLabel("A".repeat(100))).toBe(false);
  });
});

describe("assertValidLabel", () => {
  it("returns valid labels unchanged", () => {
    expect(assertValidLabel("Submarine")).toBe("Submarine");
  });

  it("throws on injection attempts", () => {
    expect(() => assertValidLabel("Foo`) DETACH DELETE n //")).toThrow(
      /Invalid Neo4j label/,
    );
    expect(() => assertValidLabel("")).toThrow(/Invalid Neo4j label/);
  });
});

describe("sanitizeLabel", () => {
  it("coerces free text into a PascalCase label", () => {
    expect(sanitizeLabel("Nuclear-powered submarine")).toBe(
      "NuclearPoweredSubmarine",
    );
    expect(sanitizeLabel("pull_request")).toBe("PullRequest");
    expect(sanitizeLabel("  Person  ")).toBe("Person");
    expect(sanitizeLabel("issue")).toBe("Issue");
    expect(sanitizeLabel("source repository")).toBe("SourceRepository");
  });

  it("normalises casing regardless of how the source spelled the type", () => {
    // snake, SCREAMING_SNAKE, camelCase, and PascalCase all collapse to one form.
    expect(sanitizeLabel("PULL_REQUEST")).toBe("PullRequest");
    expect(sanitizeLabel("pullRequest")).toBe("PullRequest");
    expect(sanitizeLabel("PullRequest")).toBe("PullRequest");
    expect(sanitizeLabel("pull request")).toBe("PullRequest");
  });

  it("is idempotent on already-PascalCase system labels", () => {
    for (const label of [
      "GraphNode",
      "EntityNode",
      "User",
      "AgentVersion",
      "SourceConnection",
    ]) {
      expect(sanitizeLabel(label)).toBe(label);
    }
  });

  it("prefixes leading-digit results so they start with a letter", () => {
    const out = sanitizeLabel("3D model");
    expect(out).toBe("N3dModel");
    expect(isValidLabel(out!)).toBe(true);
  });

  it("returns null when nothing usable remains", () => {
    expect(sanitizeLabel("!!!")).toBeNull();
    expect(sanitizeLabel("   ")).toBeNull();
  });

  it("always returns a label that passes isValidLabel", () => {
    for (const raw of [
      "a b c",
      "ALLCAPS",
      "trailing___",
      "___leading",
      "x".repeat(140),
    ]) {
      const out = sanitizeLabel(raw);
      if (out !== null) expect(isValidLabel(out)).toBe(true);
    }
  });
});

describe("toLabelKey", () => {
  it("collapses every spelling of one concept to a single key", () => {
    const key = "pullrequest";
    expect(toLabelKey("pull_request")).toBe(key);
    expect(toLabelKey("PullRequest")).toBe(key);
    expect(toLabelKey("pull request")).toBe(key);
    expect(toLabelKey("PULL_REQUEST")).toBe(key);
  });

  it("returns empty string when nothing usable remains", () => {
    expect(toLabelKey("!!!")).toBe("");
    expect(toLabelKey("   ")).toBe("");
  });
});

describe("sanitizeRelationshipType", () => {
  it("coerces descriptive types into UPPER_SNAKE_CASE", () => {
    expect(sanitizeRelationshipType("depends on")).toBe("DEPENDS_ON");
    expect(sanitizeRelationshipType("implements")).toBe("IMPLEMENTS");
    expect(sanitizeRelationshipType("PART_OF")).toBe("PART_OF");
    expect(sanitizeRelationshipType("  belongs to  ")).toBe("BELONGS_TO");
    expect(sanitizeRelationshipType("depends on (heavily)")).toBe(
      "DEPENDS_ON_HEAVILY",
    );
  });

  it("prefixes leading-digit results so they start with a letter", () => {
    expect(sanitizeRelationshipType("3-way merge")).toBe("REL_3_WAY_MERGE");
  });

  it("falls back to RELATED_TO when nothing usable remains", () => {
    expect(sanitizeRelationshipType("!!!")).toBe(FALLBACK_RELATIONSHIP_TYPE);
    expect(sanitizeRelationshipType("   ")).toBe(FALLBACK_RELATIONSHIP_TYPE);
    expect(FALLBACK_RELATIONSHIP_TYPE).toBe("RELATED_TO");
  });

  it("never returns null and always yields a value safe to interpolate", () => {
    for (const raw of [
      "a b c",
      "ALLCAPS",
      "trailing___",
      "___leading",
      "x".repeat(140),
      "Foo`)-[x]->() DETACH DELETE n //",
      "",
    ]) {
      const out = sanitizeRelationshipType(raw);
      expect(typeof out).toBe("string");
      expect(isValidLabel(out)).toBe(true);
    }
  });

  it("neutralizes Cypher-injection attempts", () => {
    // Backticks, brackets, and arrows are stripped — only the safe identifier
    // grammar survives, so the result can never break out of a type position.
    const out = sanitizeRelationshipType("Foo`)-[x]->() DETACH DELETE n //");
    expect(out).not.toMatch(/[`)\][(>/-]/);
    expect(isValidLabel(out)).toBe(true);
  });
});
