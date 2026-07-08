import { describe, expect, it } from "vitest";
import { graphNodeUpsert } from "./graph.node.upsert";
import { getCapability } from "../registry";

describe("graph.node.upsert capability", () => {
  // ── input: label ──────────────────────────────────────────────────────────

  it("accepts a valid label string", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "Alice" });
    expect(parsed.label).toBe("Person");
  });

  it("rejects an empty label (min 1)", () => {
    expect(() => graphNodeUpsert.input.parse({ label: "", displayName: "Alice" })).toThrow();
  });

  it("accepts label exactly at max length (100 chars)", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "a".repeat(100), displayName: "Alice" });
    expect(parsed.label).toHaveLength(100);
  });

  it("rejects a label exceeding 100 characters (max)", () => {
    expect(() =>
      graphNodeUpsert.input.parse({ label: "a".repeat(101), displayName: "Alice" }),
    ).toThrow();
  });

  it("rejects a missing label", () => {
    expect(() => graphNodeUpsert.input.parse({ displayName: "Alice" })).toThrow();
  });

  it("rejects a non-string label", () => {
    expect(() => graphNodeUpsert.input.parse({ label: 42, displayName: "Alice" })).toThrow();
  });

  // ── input: displayName ────────────────────────────────────────────────────

  it("accepts a valid displayName", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "Alice Smith" });
    expect(parsed.displayName).toBe("Alice Smith");
  });

  it("rejects an empty displayName (min 1)", () => {
    expect(() => graphNodeUpsert.input.parse({ label: "Person", displayName: "" })).toThrow();
  });

  it("accepts displayName exactly at max length (500 chars)", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "b".repeat(500) });
    expect(parsed.displayName).toHaveLength(500);
  });

  it("rejects a displayName exceeding 500 characters", () => {
    expect(() =>
      graphNodeUpsert.input.parse({ label: "Person", displayName: "b".repeat(501) }),
    ).toThrow();
  });

  it("rejects a missing displayName", () => {
    expect(() => graphNodeUpsert.input.parse({ label: "Person" })).toThrow();
  });

  // ── input: description (optional) ────────────────────────────────────────

  it("defaults description to undefined", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "Alice" });
    expect(parsed.description).toBeUndefined();
  });

  it("accepts a description string within max (2000 chars)", () => {
    const parsed = graphNodeUpsert.input.parse({
      label: "Person",
      displayName: "Alice",
      description: "c".repeat(2000),
    });
    expect(parsed.description).toHaveLength(2000);
  });

  it("rejects a description exceeding 2000 characters", () => {
    expect(() =>
      graphNodeUpsert.input.parse({
        label: "Person",
        displayName: "Alice",
        description: "c".repeat(2001),
      }),
    ).toThrow();
  });

  // ── input: properties (optional) ─────────────────────────────────────────

  it("defaults properties to undefined", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "Alice" });
    expect(parsed.properties).toBeUndefined();
  });

  it("accepts arbitrary key-value properties", () => {
    const parsed = graphNodeUpsert.input.parse({
      label: "Person",
      displayName: "Alice",
      properties: { role: "engineer", active: true, score: 42 },
    });
    expect(parsed.properties?.["role"]).toBe("engineer");
    expect(parsed.properties?.["active"]).toBe(true);
    expect(parsed.properties?.["score"]).toBe(42);
  });

  // ── input: externalId (optional) ──────────────────────────────────────────

  it("defaults externalId to undefined", () => {
    const parsed = graphNodeUpsert.input.parse({ label: "Person", displayName: "Alice" });
    expect(parsed.externalId).toBeUndefined();
  });

  it("accepts externalId exactly at max length (500 chars)", () => {
    const parsed = graphNodeUpsert.input.parse({
      label: "Person",
      displayName: "Alice",
      externalId: "e".repeat(500),
    });
    expect(parsed.externalId).toHaveLength(500);
  });

  it("rejects externalId exceeding 500 characters", () => {
    expect(() =>
      graphNodeUpsert.input.parse({
        label: "Person",
        displayName: "Alice",
        externalId: "e".repeat(501),
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output with nodeId and created=true", () => {
    const parsed = graphNodeUpsert.output.parse({ nodeId: "kn_abc123", created: true });
    expect(parsed.nodeId).toBe("kn_abc123");
    expect(parsed.created).toBe(true);
  });

  it("parses output with created=false (updated)", () => {
    const parsed = graphNodeUpsert.output.parse({ nodeId: "kn_abc123", created: false });
    expect(parsed.created).toBe(false);
  });

  it("rejects output missing nodeId", () => {
    expect(() => graphNodeUpsert.output.parse({ created: true })).toThrow();
  });

  it("rejects output missing created", () => {
    expect(() => graphNodeUpsert.output.parse({ nodeId: "kn_abc123" })).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("upsert_node")).toBe(graphNodeUpsert);
  });
});
