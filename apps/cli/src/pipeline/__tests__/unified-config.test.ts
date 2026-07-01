import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InvalidPipelineConfigError,
  loadUnifiedConfig,
  validateUnifiedConfig,
  type UnifiedConfig,
} from "../unified-config.js";

const ENV_KEYS = ["OXAGEN_COORDINATOR", "OXAGEN_ROUTING_TRIVIAL_MAX", "OXAGEN_MONITORS_POLL_SECONDS"];

describe("unified config", () => {
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

  it("merges every group's slice into one validated config", () => {
    const cfg = loadUnifiedConfig();
    // pipeline (Group 4) + Group 6 additions
    expect(cfg.pipeline.enabled).toBe(true);
    expect(cfg.pipeline.verifyWork).toBe(true);
    expect(cfg.pipeline.plan.minComplexity).toBe("medium");
    expect(cfg.pipeline.screenshots.requireWhenScreenImpacted).toBe(true);
    // routing (Group 2)
    expect(cfg.routing.defaultCodeWorker).toBe("sonnet-5");
    expect(cfg.routing.trivialMaxComplexity).toBe("low");
    // runtime (Group 1)
    expect(cfg.runtime.coordinator).toBe("on-device");
    // monitors (Group 5)
    expect(cfg.monitors.pollIntervalSeconds).toBe(30);
    // graph (Group 6 owns; Group 3 seam)
    expect(cfg.graph.fallbackToGrep).toBe(true);
    // loop
    expect(cfg.loop.maxJudgeRetries).toBe(2);
  });

  it("reflects env overrides from the owning group modules", () => {
    process.env["OXAGEN_COORDINATOR"] = "haiku";
    process.env["OXAGEN_ROUTING_TRIVIAL_MAX"] = "medium";
    const cfg = loadUnifiedConfig();
    expect(cfg.runtime.coordinator).toBe("haiku");
    expect(cfg.routing.trivialMaxComplexity).toBe("medium");
  });

  it("throws on an out-of-range value", () => {
    const base = loadUnifiedConfig();
    const bad: UnifiedConfig = { ...base, pipeline: { ...base.pipeline, promptEnhancement: { enabled: true, minAcceptableScore: 1.5 } } };
    expect(() => validateUnifiedConfig(bad)).toThrow(InvalidPipelineConfigError);
  });

  it("rejects a non-positive poll interval and a negative retry count", () => {
    const base = loadUnifiedConfig();
    expect(() => validateUnifiedConfig({ ...base, monitors: { ...base.monitors, pollIntervalSeconds: 0 } })).toThrow(InvalidPipelineConfigError);
    expect(() => validateUnifiedConfig({ ...base, loop: { maxJudgeRetries: -1 } })).toThrow(InvalidPipelineConfigError);
  });
});
