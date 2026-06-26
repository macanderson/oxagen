import { describe, it, expect } from "vitest";
import { computeSalience } from "./salience";
import type { EpisodicBody, SemanticBody, ProceduralBody } from "./types";

describe("computeSalience", () => {
  describe("episodic", () => {
    it("returns baseline for a plain episodic event", () => {
      const body: EpisodicBody = { event: "tool_call", payload: {} };
      expect(computeSalience("episodic", body)).toBeCloseTo(0.3);
    });

    it("boosts for failure outcome", () => {
      const body: EpisodicBody = {
        event: "tool_call",
        payload: {},
        outcome: "failure",
      };
      expect(computeSalience("episodic", body)).toBeCloseTo(0.5);
    });

    it("boosts for success outcome", () => {
      const body: EpisodicBody = {
        event: "tool_call",
        payload: {},
        outcome: "success",
      };
      expect(computeSalience("episodic", body)).toBeCloseTo(0.4);
    });

    it("boosts for high-salience event types", () => {
      const body: EpisodicBody = { event: "error", payload: {} };
      expect(computeSalience("episodic", body)).toBeCloseTo(0.45);
    });

    it("boosts for decision events", () => {
      const body: EpisodicBody = { event: "decision", payload: {} };
      expect(computeSalience("episodic", body)).toBeCloseTo(0.45);
    });

    it("stacks outcome and event type boosts", () => {
      const body: EpisodicBody = {
        event: "error",
        payload: {},
        outcome: "failure",
      };
      // 0.3 (base) + 0.2 (failure) + 0.15 (error event) = 0.65
      expect(computeSalience("episodic", body)).toBeCloseTo(0.65);
    });
  });

  describe("semantic", () => {
    it("returns baseline for a plain semantic fact", () => {
      const body: SemanticBody = { fact: "Users need auth", domain: "auth" };
      expect(computeSalience("semantic", body)).toBeCloseTo(0.5);
    });

    it("boosts for facts that supersede others", () => {
      const body: SemanticBody = {
        fact: "Updated: Users need OAuth2",
        domain: "auth",
        supersedes: ["old-fact-id"],
      };
      expect(computeSalience("semantic", body)).toBeCloseTo(0.65);
    });
  });

  describe("procedural", () => {
    it("returns baseline for a new rule", () => {
      const body: ProceduralBody = {
        rule: "Always validate input",
        appliesTo: ["api"],
        successCount: 0,
        failureCount: 0,
      };
      expect(computeSalience("procedural", body)).toBeCloseTo(0.7);
    });

    it("boosts for proven rules (>80% success, enough samples)", () => {
      const body: ProceduralBody = {
        rule: "Use parameterized queries",
        appliesTo: ["db"],
        successCount: 10,
        failureCount: 1,
      };
      // 0.7 + 0.2 = 0.9
      expect(computeSalience("procedural", body)).toBeCloseTo(0.9);
    });

    it("gives moderate boost for rules with >50% success", () => {
      const body: ProceduralBody = {
        rule: "Retry on timeout",
        appliesTo: ["api"],
        successCount: 3,
        failureCount: 2,
      };
      // 0.7 + 0.1 = 0.8
      expect(computeSalience("procedural", body)).toBeCloseTo(0.8);
    });

    it("no boost for unproven rules", () => {
      const body: ProceduralBody = {
        rule: "Try approach X",
        appliesTo: ["test"],
        successCount: 1,
        failureCount: 4,
      };
      // 20% success rate, no boost
      expect(computeSalience("procedural", body)).toBeCloseTo(0.7);
    });
  });

  describe("entity and edge", () => {
    it("returns 0.4 for entity", () => {
      expect(computeSalience("entity", {})).toBeCloseTo(0.4);
    });

    it("returns 0.3 for edge", () => {
      expect(computeSalience("edge", {})).toBeCloseTo(0.3);
    });
  });

  describe("clamping", () => {
    it("never exceeds 1.0", () => {
      // Construct a body that would stack many boosts
      const body: EpisodicBody = {
        event: "error",
        payload: {},
        outcome: "failure",
      };
      const result = computeSalience("episodic", body);
      expect(result).toBeLessThanOrEqual(1.0);
    });

    it("never goes below 0.0", () => {
      const result = computeSalience("edge", {});
      expect(result).toBeGreaterThanOrEqual(0.0);
    });
  });
});
