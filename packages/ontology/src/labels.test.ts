import { describe, it, expect } from "vitest";
import { ANCHOR_LABEL, isValidLabel, assertValidLabel, sanitizeLabel } from "./labels";

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
    expect(() => assertValidLabel("Foo`) DETACH DELETE n //")).toThrow(/Invalid Neo4j label/);
    expect(() => assertValidLabel("")).toThrow(/Invalid Neo4j label/);
  });
});

describe("sanitizeLabel", () => {
  it("coerces free text into a valid label", () => {
    expect(sanitizeLabel("Nuclear-powered submarine")).toBe("Nuclear_powered_submarine");
    expect(sanitizeLabel("pull_request")).toBe("pull_request");
    expect(sanitizeLabel("  Person  ")).toBe("Person");
  });

  it("prefixes leading-digit results so they start with a letter", () => {
    const out = sanitizeLabel("3D model");
    expect(out).toBe("N_3D_model");
    expect(isValidLabel(out!)).toBe(true);
  });

  it("returns null when nothing usable remains", () => {
    expect(sanitizeLabel("!!!")).toBeNull();
    expect(sanitizeLabel("   ")).toBeNull();
  });

  it("always returns a label that passes isValidLabel", () => {
    for (const raw of ["a b c", "ALLCAPS", "trailing___", "___leading", "x".repeat(140)]) {
      const out = sanitizeLabel(raw);
      if (out !== null) expect(isValidLabel(out)).toBe(true);
    }
  });
});
