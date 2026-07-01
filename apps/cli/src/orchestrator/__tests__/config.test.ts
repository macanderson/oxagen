import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPLEXITY_SCALE,
  complexityAtMost,
  complexityRank,
  getCheapBasicWorker,
  getDefaultCodeWorker,
  getSwitchCostTokenBudget,
  getTrivialMaxComplexity,
} from "../config.js";

const ENV_KEYS = [
  "OXAGEN_ROUTING_TRIVIAL_MAX",
  "OXAGEN_ROUTING_SWITCH_BUDGET",
  "OXAGEN_ROUTING_CODE_WORKER",
  "OXAGEN_ROUTING_BASIC_WORKER",
];

describe("orchestrator config", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("exposes the ordered complexity scale", () => {
    expect(COMPLEXITY_SCALE).toEqual(["trivial", "low", "medium", "high", "very_high"]);
  });

  it("ranks complexity and compares with <=", () => {
    expect(complexityRank("trivial")).toBe(0);
    expect(complexityRank("very_high")).toBe(4);
    expect(complexityAtMost("low", "medium")).toBe(true);
    expect(complexityAtMost("high", "low")).toBe(false);
    expect(complexityAtMost("medium", "medium")).toBe(true);
  });

  it("treats an unknown complexity as maximally complex (never trivial)", () => {
    // Guards against an off-scale label silently staying on the coordinator.
    expect(complexityRank("bogus" as never)).toBe(COMPLEXITY_SCALE.length);
    expect(complexityAtMost("bogus" as never, "very_high")).toBe(false);
  });

  it("defaults the trivial threshold to 'low'", () => {
    expect(getTrivialMaxComplexity()).toBe("low");
  });

  it("honours a valid OXAGEN_ROUTING_TRIVIAL_MAX and ignores an invalid one", () => {
    process.env["OXAGEN_ROUTING_TRIVIAL_MAX"] = "medium";
    expect(getTrivialMaxComplexity()).toBe("medium");
    process.env["OXAGEN_ROUTING_TRIVIAL_MAX"] = "not-a-level";
    expect(getTrivialMaxComplexity()).toBe("low");
  });

  it("defaults the switch-cost budget and honours a numeric override", () => {
    expect(getSwitchCostTokenBudget()).toBe(1500);
    process.env["OXAGEN_ROUTING_SWITCH_BUDGET"] = "4000";
    expect(getSwitchCostTokenBudget()).toBe(4000);
    process.env["OXAGEN_ROUTING_SWITCH_BUDGET"] = "-5";
    expect(getSwitchCostTokenBudget()).toBe(1500);
    process.env["OXAGEN_ROUTING_SWITCH_BUDGET"] = "nan";
    expect(getSwitchCostTokenBudget()).toBe(1500);
  });

  it("reads the worker ids from the registry (single source of truth)", () => {
    expect(getDefaultCodeWorker()).toBe("sonnet-5");
    expect(getCheapBasicWorker()).toBe("haiku");
  });

  it("allows env overrides of the worker ids", () => {
    process.env["OXAGEN_ROUTING_CODE_WORKER"] = "opus";
    process.env["OXAGEN_ROUTING_BASIC_WORKER"] = "sonnet-5";
    expect(getDefaultCodeWorker()).toBe("opus");
    expect(getCheapBasicWorker()).toBe("sonnet-5");
  });
});
