import { describe, it, expect } from "vitest";
import {
  AGENTS,
  AGENTS_BY_ID,
  EVALS,
  EVALS_BY_ID,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "./data";

describe("agent dataset", () => {
  it("defines the four benchmarked agents", () => {
    expect(AGENTS).toHaveLength(4);
    expect(AGENTS.map((a) => a.id)).toEqual([
      "oxagen-cli",
      "claude-code",
      "github-copilot",
      "google-gemini",
    ]);
  });

  it("anchors the Oxagen CLI as the 1.0x baseline", () => {
    const oxagen = AGENTS_BY_ID["oxagen-cli"]!;
    expect(oxagen.speedMultiplier).toBe(1.0);
    expect(oxagen.efficiencyMultiplier).toBe(1.0);
  });

  it("indexes every agent by id", () => {
    for (const agent of AGENTS) {
      expect(AGENTS_BY_ID[agent.id]).toBe(agent);
    }
  });
});

describe("eval dataset", () => {
  it("defines 12 evaluations", () => {
    expect(EVALS).toHaveLength(12);
  });

  it("indexes every eval by id", () => {
    for (const evalDef of EVALS) {
      expect(EVALS_BY_ID[evalDef.id]).toBe(evalDef);
    }
  });

  it("covers all four categories in the documented counts", () => {
    const counts = { speed: 0, efficiency: 0, accuracy: 0, quality: 0 };
    for (const evalDef of EVALS) counts[evalDef.category]++;
    expect(counts).toEqual({ speed: 2, efficiency: 3, accuracy: 3, quality: 4 });
  });

  it("uses positive baseline costs", () => {
    for (const evalDef of EVALS) {
      expect(evalDef.baseDurationMs).toBeGreaterThan(0);
      expect(evalDef.baseTokens).toBeGreaterThan(0);
    }
  });
});

describe("category metadata", () => {
  it("labels every category in order", () => {
    expect(CATEGORY_ORDER).toEqual(["speed", "efficiency", "accuracy", "quality"]);
    for (const category of CATEGORY_ORDER) {
      expect(CATEGORY_LABELS[category]).toBeTruthy();
    }
  });
});
