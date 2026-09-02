/**
 * Tests for eval/golden-traces.ts — validateTurn.
 */
import { describe, it, expect } from "vitest";
import { validateTurn, type GoldenTurn } from "./golden-traces";
import type { TaskFrame } from "../retrieval/types";
import type { TokenBudget } from "../compiler/packer";

const taskFrame: TaskFrame = {
  namespace: { org: "org", workspace: "ws" },
  taskDescription: "test task",
  workingSet: [],
  recentEventIds: [],
  modelId: "gpt-4",
};

const budget: TokenBudget = {
  total: 128000,
  reserved: { system: 500, procedural: 1000, volatile: 125000, working: 1500 },
};

function makeTurn(overrides: Partial<GoldenTurn> = {}): GoldenTurn {
  return {
    taskFrame,
    budget,
    requiredInContext: [],
    forbiddenInContext: [],
    expectedToolCalls: [],
    expectedOutcome: "success",
    ...overrides,
  };
}

describe("validateTurn", () => {
  it("passes when all required records are present and no forbidden present", () => {
    const turn = makeTurn({ requiredInContext: ["r1", "r2"] });
    const result = validateTurn(["r1", "r2", "r3"], turn);
    expect(result.pass).toBe(true);
    expect(result.precision).toBe(1.0);
    expect(result.missingRequired).toHaveLength(0);
    expect(result.includedForbidden).toHaveLength(0);
  });

  it("fails when required records are missing", () => {
    const turn = makeTurn({ requiredInContext: ["r1", "r2", "r3"] });
    const result = validateTurn(["r1"], turn);
    expect(result.pass).toBe(false);
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(["r2", "r3"]),
    );
    expect(result.missingRequired).toHaveLength(2);
  });

  it("fails when a forbidden record is included", () => {
    const turn = makeTurn({
      requiredInContext: ["r1"],
      forbiddenInContext: ["poison"],
    });
    const result = validateTurn(["r1", "poison"], turn);
    expect(result.pass).toBe(false);
    expect(result.includedForbidden).toContain("poison");
  });

  it("computes precision correctly", () => {
    const turn = makeTurn({ requiredInContext: ["r1", "r2", "r3", "r4"] });
    // Only 2 of 4 required records present
    const result = validateTurn(["r1", "r2", "extra"], turn);
    expect(result.precision).toBeCloseTo(0.5, 5);
    expect(result.missingRequired).toEqual(
      expect.arrayContaining(["r3", "r4"]),
    );
  });

  it("returns precision 1.0 when no records are required (empty required list)", () => {
    const turn = makeTurn({ requiredInContext: [] });
    const result = validateTurn(["anything"], turn);
    expect(result.pass).toBe(true);
    expect(result.precision).toBe(1.0);
  });

  it("returns precision 1.0 with empty packed list and empty required list", () => {
    const turn = makeTurn({ requiredInContext: [], forbiddenInContext: [] });
    const result = validateTurn([], turn);
    expect(result.pass).toBe(true);
    expect(result.precision).toBe(1.0);
  });

  it("fails with empty packed list when required records exist", () => {
    const turn = makeTurn({ requiredInContext: ["r1"] });
    const result = validateTurn([], turn);
    expect(result.pass).toBe(false);
    expect(result.precision).toBe(0.0);
    expect(result.missingRequired).toEqual(["r1"]);
  });

  it("handles forbidden records that are not in packed set (no false positive)", () => {
    const turn = makeTurn({
      requiredInContext: ["r1"],
      forbiddenInContext: ["poison"],
    });
    const result = validateTurn(["r1", "safe"], turn);
    expect(result.pass).toBe(true);
    expect(result.includedForbidden).toHaveLength(0);
  });

  it("fails when both missing required and forbidden present", () => {
    const turn = makeTurn({
      requiredInContext: ["r1", "r2"],
      forbiddenInContext: ["bad"],
    });
    const result = validateTurn(["r1", "bad"], turn);
    expect(result.pass).toBe(false);
    expect(result.missingRequired).toContain("r2");
    expect(result.includedForbidden).toContain("bad");
  });
});
