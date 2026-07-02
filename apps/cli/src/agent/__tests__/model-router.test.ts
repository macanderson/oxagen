/**
 * Cost-aware model router — proves the classifier picks the cheapest sufficient
 * tier, prices token usage off the vendored rate card, and honours manual pins.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Pin readConfig to empty so routeModel's "auto" path is deterministic and never
// picks up a developer's real ~/.config/oxagen/config.json `model`.
vi.mock("../../lib/config.js", () => ({ readConfig: () => ({}) }));

import {
  classifyTier,
  routeModel,
  rateFor,
  estimateCostUsd,
  formatUsd,
  accumulateUsage,
  tierForSlug,
  tierLabel,
  modelForTier,
} from "../model-router.js";
import { emptyUsage } from "../fleet/types.js";

beforeEach(() => {
  delete process.env["OXAGEN_MODEL"];
  delete process.env["OXAGEN_LLM_FAST"];
  delete process.env["OXAGEN_LLM_BALANCED"];
  delete process.env["OXAGEN_LLM_PRECISE"];
});

describe("classifyTier", () => {
  it("escalates high-stakes domains to precise regardless of size", () => {
    for (const text of [
      "fix the login session token bug",
      "add a stripe refund to billing",
      "write the RLS tenant migration",
      "rework the auth architecture",
    ]) {
      expect(classifyTier({ text }).tier).toBe("precise");
    }
  });

  it("pins trivial, mechanical single-file work to fast", () => {
    expect(classifyTier({ text: "rename the variable foo to bar" }).tier).toBe("fast");
    expect(classifyTier({ text: "fix a typo in the readme" }).tier).toBe("fast");
    expect(classifyTier({ text: "update the changelog" }).tier).toBe("fast");
  });

  it("uses balanced for non-trivial design/debugging language", () => {
    expect(classifyTier({ text: "refactor the streaming pipeline" }).tier).toBe("balanced");
    expect(classifyTier({ text: "debug why the parser drops the last token" }).tier).toBe(
      "balanced",
    );
  });

  it("escalates on breadth: many files or cross-package", () => {
    expect(classifyTier({ text: "touch up styles", fileCount: 10 }).tier).toBe("precise");
    expect(classifyTier({ text: "wire it up", fileCount: 4, crossPackage: true }).tier).toBe(
      "precise",
    );
    expect(classifyTier({ text: "wire it up", fileCount: 4 }).tier).toBe("balanced");
    expect(classifyTier({ text: "small thing", crossPackage: true }).tier).toBe("balanced");
  });

  it("treats a short unqualified ask as fast and a long one as balanced", () => {
    expect(classifyTier({ text: "add a helper" }).tier).toBe("fast");
    expect(
      classifyTier({
        text: "go through the module and make the surrounding code more readable overall please",
      }).tier,
    ).toBe("balanced");
  });

  it("always returns a concrete model slug and a rationale", () => {
    const d = classifyTier({ text: "rename foo" });
    expect(d.model).toContain("haiku");
    expect(d.rationale.length).toBeGreaterThan(0);
  });
});

describe("rate card + cost", () => {
  it("matches the model family by prefix", () => {
    expect(rateFor("anthropic/claude-opus-4.8").inputPer1M).toBe(15);
    expect(rateFor("anthropic/claude-sonnet-4.6").inputPer1M).toBe(3);
    expect(rateFor("anthropic/claude-haiku-4.5").outputPer1M).toBe(5);
    expect(rateFor("openai/gpt-5.2").inputPer1M).toBe(1.25);
  });

  it("falls back to sonnet pricing for an unknown model (never zero-charge)", () => {
    expect(rateFor("acme/mystery-1").inputPer1M).toBe(3);
  });

  it("estimates cost from token usage", () => {
    // 1M in + 1M out on opus = $15 + $75.
    expect(
      estimateCostUsd("anthropic/claude-opus-4.8", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      }),
    ).toBeCloseTo(90, 6);
  });

  it("formats USD compactly across magnitudes", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00005)).toBe("<$0.0001");
    expect(formatUsd(0.0042)).toBe("$0.0042");
    expect(formatUsd(1.2)).toBe("$1.20");
  });

  it("accumulates usage with per-call pricing", () => {
    let total = emptyUsage();
    total = accumulateUsage(total, "anthropic/claude-haiku-4.5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(total.inputTokens).toBe(1_000_000);
    expect(total.costUsd).toBeCloseTo(1, 6);
    total = accumulateUsage(total, "anthropic/claude-opus-4.8", {
      outputTokens: 1_000_000,
    });
    expect(total.outputTokens).toBe(1_000_000);
    expect(total.costUsd).toBeCloseTo(1 + 75, 6);
  });
});

describe("routeModel + tier helpers", () => {
  it("honours an explicit override and reads its tier from the slug", () => {
    const d = routeModel({ text: "rename foo" }, "anthropic/claude-opus-4.8");
    expect(d.model).toBe("anthropic/claude-opus-4.8");
    expect(d.tier).toBe("precise");
    expect(d.rationale).toBe("pinned model");
  });

  it("honours OXAGEN_MODEL as a pin", () => {
    process.env["OXAGEN_MODEL"] = "anthropic/claude-haiku-4.5";
    expect(routeModel({ text: "rework the auth layer" }).model).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });

  it("auto-routes when nothing is pinned", () => {
    expect(routeModel({ text: "fix the billing webhook signature" }).tier).toBe("precise");
  });

  it("maps slugs to tiers and tiers to labels/slugs", () => {
    expect(tierForSlug("anthropic/claude-opus-4.8")).toBe("precise");
    expect(tierForSlug("anthropic/claude-haiku-4.5")).toBe("fast");
    expect(tierForSlug("openai/gpt-4o-mini")).toBe("fast");
    expect(tierForSlug("anthropic/claude-sonnet-4.6")).toBe("balanced");
    // Cross-vendor frontier coding models → precise.
    expect(tierForSlug("openai/gpt-5.3-codex")).toBe("precise");
    expect(tierForSlug("openai/gpt-5.5-pro")).toBe("precise");
    expect(tierForSlug("google/gemini-3.1-pro-preview")).toBe("precise");
    expect(tierForSlug("deepseek/deepseek-v4-pro")).toBe("precise");
    expect(tierForSlug("mistral/mistral-large-3")).toBe("precise");
    // Cheap variants of frontier families must NOT mislabel as precise.
    expect(tierForSlug("openai/gpt-5-mini")).toBe("fast");
    expect(tierForSlug("openai/gpt-5.4-nano")).toBe("fast");
    expect(tierForSlug("openai/o3-mini")).toBe("fast");
    expect(tierForSlug("google/gemini-3.5-flash")).toBe("fast");
    expect(tierForSlug("deepseek/deepseek-v4-flash")).toBe("fast");
    expect(tierForSlug("mistral/devstral-small-2")).toBe("fast");
    // Mid-tier coders default to balanced.
    expect(tierForSlug("mistral/devstral-2")).toBe("balanced");
    expect(tierForSlug("deepseek/deepseek-v3.2-thinking")).toBe("balanced");
    expect(tierLabel("fast")).toBe("Haiku");
    expect(tierLabel("balanced")).toBe("Sonnet");
    expect(tierLabel("precise")).toBe("Fable");
    expect(modelForTier("precise")).toContain("fable");
  });

  it("respects env overrides for tier slugs", () => {
    process.env["OXAGEN_LLM_FAST"] = "anthropic/claude-haiku-9";
    expect(modelForTier("fast")).toBe("anthropic/claude-haiku-9");
  });
});
