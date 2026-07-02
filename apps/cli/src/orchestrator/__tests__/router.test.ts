import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRouter, createRouter } from "../router.js";
import type { OrchestratorLogEntry } from "../logging.js";
import type { RoutingTask } from "../types.js";

/** Capture routing log entries instead of writing to the debug stream. */
function capturingRouter() {
  const entries: OrchestratorLogEntry[] = [];
  const router = new ModelRouter({ log: (e) => entries.push(e) });
  return { router, entries };
}

const ENV_KEYS = [
  "OXAGEN_COORDINATOR",
  "OXAGEN_ROUTING_TRIVIAL_MAX",
  "OXAGEN_ROUTING_SWITCH_BUDGET",
  "OXAGEN_ROUTING_CODE_WORKER",
  "OXAGEN_ROUTING_BASIC_WORKER",
];

describe("ModelRouter", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Pin a deterministic coordinator so trivial routing is stable.
    process.env["OXAGEN_COORDINATOR"] = "on-device";
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("keeps trivial work on the coordinator (no dispatch)", () => {
    const { router, entries } = capturingRouter();
    const task: RoutingTask = { complexity: "low", writesCode: false, promptTokens: 40 };
    const d = router.route(task);

    expect(d.isCoordinator).toBe(true);
    expect(d.model).toBe("on-device");
    expect(d.workerModelRecorded).toBeNull();
    expect(d.reason).toContain("trivial");
    // Logged the decision.
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "route", coordinator: true, selected: "on-device" });
  });

  it("treats the 'trivial' complexity itself as coordinator work", () => {
    const { router } = capturingRouter();
    const d = router.route({ complexity: "trivial", writesCode: true, promptTokens: 5 });
    expect(d.isCoordinator).toBe(true);
  });

  it("dispatches above-trivial code work to the default code worker (sonnet-5)", () => {
    const { router, entries } = capturingRouter();
    const d = router.route({ complexity: "medium", writesCode: true, promptTokens: 300 });

    expect(d.isCoordinator).toBe(false);
    expect(d.model).toBe("sonnet-5");
    expect(d.workerModelRecorded).toBe("sonnet-5");
    expect(entries[0]).toMatchObject({ kind: "route", coordinator: false, selected: "sonnet-5" });
  });

  it("picks the cheapest capable model for above-trivial non-code work", () => {
    const { router } = capturingRouter();
    // Non-code medium work: haiku is capable and cheapest; default task value is
    // too low for the quality gain to justify an upgrade at this prompt length.
    const d = router.route({ complexity: "medium", writesCode: false, promptTokens: 200 });
    expect(d.model).toBe("haiku");
    expect(d.workerModelRecorded).toBe("haiku");
  });

  it("requires the strongest model for very-high complexity code", () => {
    const { router } = capturingRouter();
    const d = router.route({ complexity: "very_high", writesCode: true, promptTokens: 100 });
    expect(d.model).toBe("fable");
  });

  it("does NOT switch to a stronger model for a small gain on a long prompt", () => {
    const { router } = capturingRouter();
    // Baseline is sonnet-5 (code floor). Opus is only marginally better, and the
    // long prompt makes the mid-turn switch expensive — stay on the cheaper model.
    const d = router.route({
      complexity: "medium",
      writesCode: true,
      promptTokens: 8000,
      taskValue: 0.3,
    });
    expect(d.model).toBe("sonnet-5");
    expect(d.reason).toContain("cheapest");
  });

  it("DOES upgrade when a high-value task makes the switch worth it on a short prompt", () => {
    const { router } = capturingRouter();
    const d = router.route({
      complexity: "medium",
      writesCode: true,
      promptTokens: 10,
      taskValue: 1,
    });
    expect(d.model).toBe("fable");
    expect(d.reason).toContain("upgrade");
  });

  it("records the worker model on every worker decision (for a different judge)", () => {
    const { router } = capturingRouter();
    const worker = router.route({ complexity: "high", writesCode: true, promptTokens: 500 });
    expect(worker.workerModelRecorded).toBe(worker.model);
    expect(worker.workerModelRecorded).not.toBe("on-device");
  });

  describe("estimateSwitchCost", () => {
    it("is zero when the model does not change", () => {
      const { router } = capturingRouter();
      expect(router.estimateSwitchCost("sonnet-5", "sonnet-5", 1234)).toBe(0);
    });
    it("adds prompt tokens to the re-sent context (prompt length is a factor)", () => {
      const { router } = capturingRouter();
      const short = router.estimateSwitchCost("sonnet-5", "fable", 100);
      const long = router.estimateSwitchCost("sonnet-5", "fable", 100000);
      expect(long).toBeGreaterThan(short);
      expect(short).toBe(100 + 1500);
    });
  });

  it("honours OXAGEN_ROUTING_TRIVIAL_MAX to widen the coordinator's remit", () => {
    process.env["OXAGEN_ROUTING_TRIVIAL_MAX"] = "medium";
    const { router } = capturingRouter();
    const d = router.route({ complexity: "medium", writesCode: true, promptTokens: 100 });
    expect(d.isCoordinator).toBe(true);
  });

  it("falls back to the strongest worker when nothing meets the required quality", () => {
    // Force the code floor above every dispatchable worker's quality: the judge
    // model is excluded from workers, so a floor at its capability leaves the
    // eligible set empty and the router must still not drop the task.
    process.env["OXAGEN_ROUTING_CODE_WORKER"] = "openai-most-capable-coding-model";
    const { router } = capturingRouter();
    const d = router.route({ complexity: "high", writesCode: true, promptTokens: 100 });
    expect(d.isCoordinator).toBe(false);
    expect(d.model).toBe("fable"); // strongest dispatchable worker
    expect(d.reason).toContain("no worker meets required quality");
    expect(d.workerModelRecorded).toBe("fable");
  });

  it("createRouter builds a working router", () => {
    const r = createRouter();
    const d = r.route({ complexity: "trivial", writesCode: false, promptTokens: 1 });
    expect(d.isCoordinator).toBe(true);
  });
});
