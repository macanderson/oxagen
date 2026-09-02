import { describe, it, expect } from "vitest";
import { scoreCandidate, fuzzyNameScore } from "./resolve";
import type { EntityMutation } from "../types";

// ── fuzzyNameScore ──────────────────────────────────────────────────────────

describe("fuzzyNameScore", () => {
  it("returns 1.0 for identical names", () => {
    expect(fuzzyNameScore("Mac Anderson", "Mac Anderson")).toBe(1);
  });

  it("returns 1.0 for case-insensitive matches", () => {
    expect(fuzzyNameScore("Mac Anderson", "mac anderson")).toBe(1);
  });

  it("returns 1.0 for identical after stripping punctuation", () => {
    expect(fuzzyNameScore("Mac Anderson!", "Mac Anderson?")).toBe(1);
  });

  it("returns < 0.3 for very different names", () => {
    expect(fuzzyNameScore("Mac Anderson", "John Smith")).toBeLessThan(0.3);
  });

  it("returns between 0.5 and 0.9 for partial overlap", () => {
    const score = fuzzyNameScore("Thomas Mac Anderson", "Mac Anderson");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThan(0.9);
  });

  it("returns 1.0 for empty strings", () => {
    expect(fuzzyNameScore("", "")).toBe(1);
  });

  it("returns 0 or low for completely different single chars", () => {
    expect(fuzzyNameScore("a", "z")).toBe(0);
  });
});

// ── scoreCandidate ──────────────────────────────────────────────────────────

function makeMutation(overrides: Partial<EntityMutation> = {}): EntityMutation {
  return {
    workspaceId: "ws-1",
    orgId: "org-1",
    connectionId: "conn-1",
    entityType: "contact",
    sourceRecordType: "user",
    naturalKey: "github:conn-1:alice",
    operation: "insert",
    displayName: "Alice Smith",
    properties: {},
    sourceRef: {
      connectorType: "github",
      connectionId: "conn-1",
      externalId: "alice",
    },
    ...overrides,
  };
}

describe("scoreCandidate", () => {
  it("scores embedding similarity at 0.4 weight when no property match", () => {
    const mutation = makeMutation({ properties: {}, displayName: undefined });
    const score = scoreCandidate(mutation, { displayName: undefined }, 0.5);
    // Only embedding contributes: 0.5 * 0.4 = 0.2
    expect(score).toBeCloseTo(0.2, 3);
  });

  it("adds 0.4 for exact email match", () => {
    const mutation = makeMutation({
      properties: { email: "alice@example.com" },
      displayName: undefined,
    });
    const candidate = { email: "alice@example.com", displayName: undefined };
    const score = scoreCandidate(mutation, candidate, 0.0);
    expect(score).toBeCloseTo(0.4, 3);
  });

  it("email match is case-insensitive", () => {
    const mutation = makeMutation({
      properties: { email: "ALICE@EXAMPLE.COM" },
      displayName: undefined,
    });
    const candidate = { email: "alice@example.com" };
    const score = scoreCandidate(mutation, candidate, 0.0);
    expect(score).toBeCloseTo(0.4, 3);
  });

  it("adds 0.4 for exact URL match when no email matches", () => {
    const mutation = makeMutation({
      properties: { url: "https://example.com/alice" },
      displayName: undefined,
    });
    const candidate = { url: "https://example.com/alice" };
    const score = scoreCandidate(mutation, candidate, 0.0);
    expect(score).toBeCloseTo(0.4, 3);
  });

  it("does not double-count email + URL bonus", () => {
    // If both email matches — only adds 0.4 once (email takes precedence)
    const mutation = makeMutation({
      properties: { email: "a@x.com", url: "https://x.com" },
      displayName: undefined,
    });
    const candidate = { email: "a@x.com", url: "https://x.com" };
    const score = scoreCandidate(mutation, candidate, 0.0);
    expect(score).toBeCloseTo(0.4, 3);
  });

  it("adds fuzzy name similarity at 0.2 weight", () => {
    const mutation = makeMutation({
      displayName: "Alice Smith",
      properties: {},
    });
    const candidate = { displayName: "Alice Smith" };
    // score = 0 (embed) + 0 (no email/url) + 1.0 * 0.2 = 0.2
    const score = scoreCandidate(mutation, candidate, 0.0);
    expect(score).toBeCloseTo(0.2, 3);
  });

  it("combines all three signals", () => {
    const mutation = makeMutation({
      displayName: "Alice Smith",
      properties: { email: "alice@example.com" },
    });
    const candidate = {
      displayName: "Alice Smith",
      email: "alice@example.com",
    };
    // 0.8 * 0.4 = 0.32 (embed) + 0.4 (email) + 1.0 * 0.2 = 0.92
    const score = scoreCandidate(mutation, candidate, 0.8);
    expect(score).toBeCloseTo(0.92, 3);
  });

  it("caps at 1.0", () => {
    const mutation = makeMutation({
      displayName: "Alice",
      properties: { email: "alice@x.com" },
    });
    const candidate = { displayName: "Alice", email: "alice@x.com" };
    const score = scoreCandidate(mutation, candidate, 1.0);
    expect(score).toBe(1); // Math.min(1, result)
  });
});
