/**
 * Tests for consolidation/resolve.ts — detectContradiction and resolveConflict.
 */
import { describe, it, expect } from "vitest";
import { detectContradiction, resolveConflict } from "./resolve";
import { createRecord } from "../record";
import type {
  Namespace,
  Provenance,
  MemoryRecord,
  SemanticBody,
} from "../types";

const NS: Namespace = { org: "test-org", workspace: "test-ws" };
const PROV: Provenance = {
  author: "test",
  derivedFrom: [],
  timestamp: Date.now(),
};

function makeSemantic(
  fact: string,
  domain: string,
  confidence = 0.8,
): MemoryRecord {
  return createRecord({
    kind: "semantic",
    namespace: NS,
    body: { fact, domain } satisfies SemanticBody,
    salience: 0.7,
    confidence,
    provenance: PROV,
  });
}

describe("detectContradiction", () => {
  it("returns false for facts in different domains", () => {
    const existing = makeSemantic("The API uses REST", "api");
    const newFact: SemanticBody = {
      fact: "The API does not use REST",
      domain: "auth",
    };
    expect(detectContradiction(newFact, existing)).toBe(false);
  });

  it("detects negation contradiction within the same domain", () => {
    const existing = makeSemantic("The API uses JWT authentication", "auth");
    const newFact: SemanticBody = {
      fact: "The API does not use JWT authentication",
      domain: "auth",
    };
    // High word overlap + negation difference
    expect(detectContradiction(newFact, existing)).toBe(true);
  });

  it("does not flag when both have the same negation", () => {
    const existing = makeSemantic("The service never stores passwords", "auth");
    const newFact: SemanticBody = {
      fact: "The service never stores plaintext passwords",
      domain: "auth",
    };
    // Both have "never" — no negation mismatch
    expect(detectContradiction(newFact, existing)).toBe(false);
  });

  it("detects numeric contradiction (same subject, different numbers)", () => {
    const existing = makeSemantic(
      "The service has 100 active users",
      "billing",
    );
    const newFact: SemanticBody = {
      fact: "The service has 200 active users",
      domain: "billing",
    };
    expect(detectContradiction(newFact, existing)).toBe(true);
  });

  it("does not flag numeric facts with low word overlap", () => {
    const existing = makeSemantic("Timeout is set to 30 seconds", "api");
    const newFact: SemanticBody = {
      fact: "The database has 50 tables",
      domain: "api",
    };
    // Different subjects, overlap < 0.5
    expect(detectContradiction(newFact, existing)).toBe(false);
  });

  it("returns false for completely unrelated facts in same domain", () => {
    const existing = makeSemantic("The auth module uses PKCE", "auth");
    const newFact: SemanticBody = {
      fact: "Database migrations run at startup",
      domain: "auth",
    };
    expect(detectContradiction(newFact, existing)).toBe(false);
  });

  it("returns false when neither fact has numbers", () => {
    const existing = makeSemantic("The API is deployed to AWS", "infra");
    const newFact: SemanticBody = {
      fact: "The frontend is deployed to Vercel",
      domain: "infra",
    };
    expect(detectContradiction(newFact, existing)).toBe(false);
  });
});

describe("resolveConflict", () => {
  it("keeps new when confidence diff > 0.3", () => {
    const existing = makeSemantic("Old fact", "auth", 0.5);
    const newFact: SemanticBody = { fact: "New fact", domain: "auth" };
    const result = resolveConflict(existing, newFact, 0.9, ["e1", "e2"]);
    expect(result.resolution).toBe("keep_new");
    expect(result.reason).toContain("higher confidence");
  });

  it("keeps existing when existing has much higher confidence", () => {
    const existing = makeSemantic("High confidence fact", "auth", 0.95);
    const newFact: SemanticBody = {
      fact: "Low confidence challenger",
      domain: "auth",
    };
    const result = resolveConflict(existing, newFact, 0.5, ["e1"]);
    expect(result.resolution).toBe("keep_existing");
    expect(result.reason).toContain("higher confidence");
  });

  it("keeps new when supported by 5+ evidence records", () => {
    const existing = makeSemantic("Weakly supported", "auth", 0.7);
    const newFact: SemanticBody = { fact: "Well supported", domain: "auth" };
    const evidence = ["e1", "e2", "e3", "e4", "e5"];
    const result = resolveConflict(existing, newFact, 0.72, evidence);
    // Confidence diff is only 0.02, but evidence count >= 5
    expect(result.resolution).toBe("keep_new");
    expect(result.reason).toContain("5 independent observations");
  });

  it("escalates to human_review when both have very high confidence", () => {
    const existing = makeSemantic("High confidence fact", "auth", 0.95);
    const newFact: SemanticBody = {
      fact: "Also high confidence",
      domain: "auth",
    };
    const result = resolveConflict(existing, newFact, 0.92, ["e1", "e2"]);
    // Both >= 0.9, confidence diff < 0.3
    expect(result.resolution).toBe("human_review");
    expect(result.reason).toContain("human decision");
  });

  it("keeps both when ambiguous (moderate confidence, few evidence)", () => {
    const existing = makeSemantic("Moderate fact", "auth", 0.65);
    const newFact: SemanticBody = {
      fact: "Another moderate fact",
      domain: "auth",
    };
    const result = resolveConflict(existing, newFact, 0.68, ["e1"]);
    // Confidence diff = 0.03 (< 0.3), evidence = 1 (< 5), neither >= 0.9
    expect(result.resolution).toBe("keep_both");
    expect(result.reason).toContain("Ambiguous");
  });

  it("includes correct existingId in result", () => {
    const existing = makeSemantic("Old fact", "auth", 0.5);
    const newFact: SemanticBody = { fact: "New fact", domain: "auth" };
    const result = resolveConflict(existing, newFact, 0.9, []);
    expect(result.existingId).toBe(existing.id);
  });

  it("includes newFact and evidence in result", () => {
    const existing = makeSemantic("Old fact", "test", 0.5);
    const newFact: SemanticBody = { fact: "New fact", domain: "test" };
    const evidence = ["ev-1", "ev-2"];
    const result = resolveConflict(existing, newFact, 0.9, evidence);
    expect(result.newFact).toEqual(newFact);
    expect(result.evidence).toEqual(evidence);
  });

  it("formats confidence values in reason string", () => {
    const existing = makeSemantic("Old", "test", 0.5);
    const newFact: SemanticBody = { fact: "New", domain: "test" };
    const result = resolveConflict(existing, newFact, 0.9, []);
    expect(result.reason).toContain("0.90");
    expect(result.reason).toContain("0.50");
  });
});
