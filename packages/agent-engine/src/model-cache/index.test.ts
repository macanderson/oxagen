import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  validateEffort,
  getSupportedEfforts,
  type ModelCache,
  type EffortLevel,
} from "./index";

describe("model-cache", () => {
  const mockCache: ModelCache = {
    cachedAt: Date.now(),
    ttlMs: 24 * 60 * 60 * 1000,
    models: {
      "claude-fable-5": {
        id: "claude-fable-5",
        provider: "anthropic",
        name: "Claude Fable 5",
        supportedEfforts: ["low", "medium", "high", "max"],
        contextWindow: 8000,
        maxOutputTokens: 4096,
        costPer1MInputTokens: 3.0,
      },
      "claude-haiku-4-5-20251001": {
        id: "claude-haiku-4-5-20251001",
        provider: "anthropic",
        name: "Claude Haiku 4.5",
        supportedEfforts: ["low", "medium"],
        contextWindow: 8000,
        maxOutputTokens: 1024,
        costPer1MInputTokens: 0.8,
      },
    },
  };

  describe("validateEffort", () => {
    it("accepts supported effort levels", () => {
      const result = validateEffort("claude-fable-5", "max", mockCache);
      expect(result.supported).toBe(true);
      expect(result.clampedEffort).toBe("max");
    });

    it("clamps unsupported efforts to highest supported", () => {
      const result = validateEffort("claude-haiku-4-5-20251001", "max", mockCache);
      expect(result.supported).toBe(false);
      expect(result.clampedEffort).toBe("medium");
      expect(result.reason).toContain("clamped");
    });

    it("defaults to 'medium' when no effort specified", () => {
      const result = validateEffort("claude-fable-5", undefined, mockCache);
      expect(result.clampedEffort).toBe("medium");
      expect(result.supported).toBe(true);
    });

    it("uses fallback capabilities for unknown models", () => {
      const result = validateEffort("unknown-model", "max", mockCache);
      // Fallback for unknown is ["low", "medium"], so "max" gets clamped
      expect(result.supported).toBe(false);
      expect(result.clampedEffort).toBe("medium");
    });

    it("returns reason when clamping occurs", () => {
      const result = validateEffort("claude-haiku-4-5-20251001", "high", mockCache);
      expect(result.reason).toBeDefined();
      expect(result.reason).toContain("claude-haiku");
    });

    it("clamps 'high' effort on haiku to 'medium'", () => {
      const result = validateEffort("claude-haiku-4-5-20251001", "high", mockCache);
      expect(result.clampedEffort).toBe("medium");
    });

    it("accepts 'medium' effort on all models", () => {
      const models = ["claude-fable-5", "claude-haiku-4-5-20251001"];
      for (const modelId of models) {
        const result = validateEffort(modelId, "medium", mockCache);
        expect(result.supported).toBe(true);
        expect(result.clampedEffort).toBe("medium");
      }
    });
  });

  describe("getSupportedEfforts", () => {
    it("returns supported efforts from cache", () => {
      const efforts = getSupportedEfforts("claude-fable-5", mockCache);
      expect(efforts).toEqual(["low", "medium", "high", "max"]);
    });

    it("returns fallback for unknown model", () => {
      const efforts = getSupportedEfforts("unknown", mockCache);
      expect(efforts).toEqual(["low", "medium"]);
    });

    it("respects model-specific limitations", () => {
      const fableEfforts = getSupportedEfforts("claude-fable-5", mockCache);
      const haikuEfforts = getSupportedEfforts("claude-haiku-4-5-20251001", mockCache);
      expect(fableEfforts.length).toBeGreaterThan(haikuEfforts.length);
      expect(fableEfforts).toContain("max");
      expect(haikuEfforts).not.toContain("max");
    });
  });

  describe("effort clamping scenarios", () => {
    it("scenario: fable max → stays max", () => {
      const result = validateEffort("claude-fable-5", "max", mockCache);
      expect(result.clampedEffort).toBe("max");
      expect(result.supported).toBe(true);
    });

    it("scenario: haiku max → clamps to medium", () => {
      const result = validateEffort("claude-haiku-4-5-20251001", "max", mockCache);
      expect(result.clampedEffort).toBe("medium");
      expect(result.supported).toBe(false);
    });

    it("scenario: any model with 'low' → stays low", () => {
      const fableResult = validateEffort("claude-fable-5", "low", mockCache);
      const haikuResult = validateEffort("claude-haiku-4-5-20251001", "low", mockCache);
      expect(fableResult.clampedEffort).toBe("low");
      expect(haikuResult.clampedEffort).toBe("low");
    });

    it("scenario: default (no effort) → medium for all", () => {
      const fableResult = validateEffort("claude-fable-5", undefined, mockCache);
      const haikuResult = validateEffort("claude-haiku-4-5-20251001", undefined, mockCache);
      expect(fableResult.clampedEffort).toBe("medium");
      expect(haikuResult.clampedEffort).toBe("medium");
    });
  });
});
