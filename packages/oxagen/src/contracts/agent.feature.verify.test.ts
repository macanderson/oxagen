import { describe, expect, it } from "vitest";
import { agentFeatureVerify } from "./agent.feature.verify";
import { getCapability } from "../registry";

describe("agent.feature.verify capability", () => {
  it("is registered with the agent domain metadata", () => {
    const cap = getCapability("verify_feature");
    expect(cap).toBeDefined();
    expect(cap?.domain).toBe("agent");
    expect(cap?.scoped).toBe(true);
    expect(cap?.surfaces).toEqual(
      expect.arrayContaining(["api", "mcp", "agent"]),
    );
  });

  it("requires both requirement and screenshotKeys", () => {
    expect(() => agentFeatureVerify.input.parse({})).toThrow();
    expect(() =>
      agentFeatureVerify.input.parse({ requirement: "show login form" }),
    ).toThrow();
    expect(() =>
      agentFeatureVerify.input.parse({ screenshotKeys: ["key_1"] }),
    ).toThrow();
  });

  it("enforces screenshotKeys minimum of 1", () => {
    expect(() =>
      agentFeatureVerify.input.parse({
        requirement: "show login form",
        screenshotKeys: [],
      }),
    ).toThrow();
  });

  it("accepts valid required fields", () => {
    const parsed = agentFeatureVerify.input.parse({
      requirement: "The login form renders with email and password fields",
      screenshotKeys: ["asset_abc123"],
    });
    expect(parsed.requirement).toBe(
      "The login form renders with email and password fields",
    );
    expect(parsed.screenshotKeys).toHaveLength(1);
    expect(parsed.builderModel).toBeUndefined();
    expect(parsed.checklist).toBeUndefined();
  });

  it("treats builderModel and checklist as optional", () => {
    const withOptionals = agentFeatureVerify.input.parse({
      requirement: "The dashboard chart loads",
      screenshotKeys: ["asset_1", "asset_2"],
      builderModel: "anthropic/claude-opus-4.8",
      checklist: ["Chart is visible", "Legend is rendered"],
    });
    expect(withOptionals.builderModel).toBe("anthropic/claude-opus-4.8");
    expect(withOptionals.checklist).toHaveLength(2);
  });

  it("output schema parses a valid verdict object", () => {
    const out = agentFeatureVerify.output.parse({
      verdict: "pass",
      confidence: 0.95,
      judgeModel: "google/gemini-2.5-pro",
      builderModel: "anthropic/claude-opus-4.8",
      observations: ["Login form is visible with email and password fields"],
      issues: [],
      reasoning:
        "The screenshots clearly show a login form matching the requirement.",
    });
    expect(out.verdict).toBe("pass");
    expect(out.confidence).toBe(0.95);
    expect(out.judgeModel).toBe("google/gemini-2.5-pro");
    expect(out.builderModel).toBe("anthropic/claude-opus-4.8");
    expect(out.observations).toHaveLength(1);
    expect(out.issues).toHaveLength(0);
  });

  it("output accepts null builderModel", () => {
    const out = agentFeatureVerify.output.parse({
      verdict: "inconclusive",
      confidence: 0.4,
      judgeModel: "google/gemini-2.5-pro",
      builderModel: null,
      observations: ["Screenshot is too small to determine feature state"],
      issues: ["Screenshot resolution is too low"],
      reasoning: "Cannot determine from the provided images.",
    });
    expect(out.verdict).toBe("inconclusive");
    expect(out.builderModel).toBeNull();
  });

  it("verdict enum rejects an unknown value", () => {
    expect(() =>
      agentFeatureVerify.output.parse({
        verdict: "maybe",
        confidence: 0.5,
        judgeModel: "google/gemini-2.5-pro",
        builderModel: null,
        observations: [],
        issues: [],
        reasoning: "Not sure.",
      }),
    ).toThrow();
  });
});
