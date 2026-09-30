import { readFileSync } from "node:fs";
import { type CedarRuntime, requireCedarRuntime } from "@oxagen/policy";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AutonomyLevel, AutonomyScope, WorkAction, WorkFile } from "../types";
import {
  type AutonomyFacts,
  HIGH_RISK_FORBID_ID,
  RISK_UNKNOWN_FORBID_ID,
  autonomyAllows,
  autonomyLevelFor,
  evaluateAutonomy,
  generateAutonomyPolicy,
  loadAutonomyRuntime,
  permitId,
} from "./autonomy-allows";

let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
  expect(await loadAutonomyRuntime()).toBe(true);
});

const DOCS: AutonomyScope = { label: "Documentation" };
const BILLING: AutonomyScope = { repo: "aintel/billing-service", paths: ["src/**"] };
const ACTIONS: readonly WorkAction[] = ["work.send", "work.merge", "work.lock", "work.close"];

function facts(overrides: Partial<AutonomyFacts> = {}): AutonomyFacts {
  return {
    operator: "priya",
    level: 2,
    verdict: "proven",
    risk: "low",
    lintPassed: true,
    closeSwitch: true,
    spentTodayUsd: 0,
    maxDailyUsd: 40,
    ...overrides,
  };
}

function fixtureWork(): WorkFile {
  return parseToml(readFileSync(new URL("../../fixtures/work.toml", import.meta.url), "utf8")) as unknown as WorkFile;
}

describe("autonomyAllows by level", () => {
  // agent-work-spec.html (Autonomy levels): what each level adds to the one below.
  const TABLE: ReadonlyArray<[AutonomyLevel, readonly WorkAction[]]> = [
    [0, []],
    [1, ["work.send"]],
    [2, ["work.send", "work.merge"]],
    [3, ["work.send", "work.merge", "work.lock", "work.close"]],
  ];

  it.each(TABLE)("level %i allows exactly %j", (level, allowed) => {
    for (const action of ACTIONS) {
      const result = autonomyAllows(DOCS, action, facts({ level }));
      if (allowed.includes(action)) {
        expect(result, action).toEqual({ decision: "allow", reasons: [permitId(action, DOCS)], errors: [] });
      } else {
        expect(result, action).toEqual({ decision: "deny", reasons: [], errors: [] });
      }
    }
  });

  it("denies work.lock at level 3 when the drafted record fails lint", () => {
    expect(autonomyAllows(DOCS, "work.lock", facts({ level: 3, lintPassed: false })).decision).toBe("deny");
  });

  it("denies work.close at level 3 when the collector's close switch is off", () => {
    expect(autonomyAllows(DOCS, "work.close", facts({ level: 3, closeSwitch: false })).decision).toBe("deny");
  });
});

describe("autonomyAllows on merge", () => {
  it.each([2, 3] as const)("never merges high-risk work at level %i", (level) => {
    const result = autonomyAllows(DOCS, "work.merge", facts({ level, risk: "high" }));
    expect(result).toEqual({ decision: "deny", reasons: [HIGH_RISK_FORBID_ID], errors: [] });
  });

  it("still sends high-risk work at level 2, because the forbid covers merge alone", () => {
    expect(autonomyAllows(DOCS, "work.send", facts({ risk: "high" })).decision).toBe("allow");
  });

  it("merges medium-risk work at level 2", () => {
    expect(autonomyAllows(DOCS, "work.merge", facts({ risk: "medium" })).decision).toBe("allow");
  });

  it("does not merge work whose risk is not known yet", () => {
    const result = autonomyAllows(DOCS, "work.merge", facts({ risk: null }));
    expect(result).toEqual({ decision: "deny", reasons: [RISK_UNKNOWN_FORBID_ID], errors: [] });
  });

  it.each(["pending", "held", "broken"] as const)("does not merge a %s record", (verdict) => {
    expect(autonomyAllows(DOCS, "work.merge", facts({ verdict }))).toEqual({
      decision: "deny",
      reasons: [],
      errors: [],
    });
  });
});

describe("autonomyAllows with a lowering", () => {
  it("applies an automatic lowering before the steering PR that writes it merges", () => {
    const work = fixtureWork();
    const target = { labels: ["Documentation"] };
    const before = autonomyLevelFor(work, target, []).level;
    expect(before).toBe(2);
    expect(autonomyAllows(DOCS, "work.merge", facts({ level: before })).decision).toBe("allow");

    // work.toml still says level 2. Only the work.autonomy_events row says 1.
    const lowered = autonomyLevelFor(work, target, [
      { scope: DOCS, toLevel: 1, createdAt: new Date("2026-09-29T11:59:00Z") },
    ]).level;
    expect(lowered).toBe(1);
    expect(autonomyAllows(DOCS, "work.merge", facts({ level: lowered })).decision).toBe("deny");
    expect(autonomyAllows(DOCS, "work.send", facts({ level: lowered })).decision).toBe("allow");
  });
});

describe("autonomyAllows with a budget", () => {
  it("sends while today's spend is under max_daily_usd, and stops at it", () => {
    expect(autonomyAllows(DOCS, "work.send", facts({ spentTodayUsd: 39.99 })).decision).toBe("allow");
    expect(autonomyAllows(DOCS, "work.send", facts({ spentTodayUsd: 40 })).decision).toBe("deny");
  });

  it("sends at any spend when the scope sets no budget", () => {
    const result = autonomyAllows(DOCS, "work.send", facts({ spentTodayUsd: 10_000, maxDailyUsd: undefined }));
    expect(result.decision).toBe("allow");
  });

  it("refuses a budget that is not a number of dollars above 0", () => {
    expect(autonomyAllows(DOCS, "work.send", facts({ maxDailyUsd: 0 }))).toEqual({
      decision: "deny",
      reasons: [],
      errors: ["max_daily_usd must be a number of dollars above 0."],
    });
  });
});

describe("autonomyAllows with facts it cannot use", () => {
  it.each<[string, AutonomyScope, WorkAction, Partial<AutonomyFacts>, string]>([
    ["an unknown action", DOCS, "work.deploy" as never, {}, "The action must be one of work.send, work.merge, work.lock, work.close."],
    ["a level outside 0 to 3", DOCS, "work.send", { level: 5 as never }, "The level must be 0, 1, 2, or 3."],
    ["an unknown verdict", DOCS, "work.merge", { verdict: "done" as never }, "The verdict must be one of pending, held, proven, broken."],
    ["an unknown risk", DOCS, "work.merge", { risk: "severe" as never }, "The risk must be low, medium, high, or null."],
    ["a lint result that is not a boolean", DOCS, "work.lock", { lintPassed: "yes" as never }, "lintPassed must be true or false."],
    ["a close switch that is not a boolean", DOCS, "work.close", { closeSwitch: 1 as never }, "closeSwitch must be true or false."],
    ["a negative spend", DOCS, "work.send", { spentTodayUsd: -1 }, "spentTodayUsd must be a number of dollars, 0 or more."],
    ["a spend that is not a number", DOCS, "work.send", { spentTodayUsd: Number.NaN }, "spentTodayUsd must be a number of dollars, 0 or more."],
    ["a spend too large for Cedar's Long", DOCS, "work.send", { spentTodayUsd: 1e300 }, "spentTodayUsd must be a number of dollars, 0 or more."],
    ["an empty operator", DOCS, "work.send", { operator: " " }, "Every scope needs an operator. Oxagen acts as that person at every level."],
    ["a scope that does not parse", { label: "" }, "work.send", {}, "The scope must be { label } or { repo, paths } with at least one path, and no value may be empty."],
  ])("denies %s and says why", (_name, scope, action, overrides, error) => {
    expect(autonomyAllows(scope, action, facts({ level: 3, ...overrides }))).toEqual({
      decision: "deny",
      reasons: [],
      errors: [error],
    });
  });

  it("matches an operator whose name holds a quote", () => {
    expect(autonomyAllows(DOCS, "work.send", facts({ operator: 'pri"ya' })).decision).toBe("allow");
  });
});

describe("autonomyAllows before the evaluator loads", () => {
  afterEach(async () => {
    expect(await loadAutonomyRuntime()).toBe(true);
  });

  it("denies every action while this host has no evaluator", async () => {
    expect(await loadAutonomyRuntime(async () => null)).toBe(false);
    expect(autonomyAllows(DOCS, "work.send", facts())).toEqual({
      decision: "deny",
      reasons: [],
      errors: ["Cedar's evaluator is not loaded. Call loadAutonomyRuntime() when the process starts."],
    });
  });
});

describe("evaluateAutonomy", () => {
  const all = () => generateAutonomyPolicy(fixtureWork()).policies;

  it("keeps each scope's permits to that scope and its operator", () => {
    expect(evaluateAutonomy(runtime, all(), DOCS, "work.send", facts({ operator: "sam" })).decision).toBe("deny");
    expect(evaluateAutonomy(runtime, all(), BILLING, "work.send", facts({ level: 1 })).decision).toBe("deny");
    expect(evaluateAutonomy(runtime, all(), BILLING, "work.send", facts({ operator: "sam", level: 1 }))).toEqual({
      decision: "allow",
      reasons: [permitId("work.send", BILLING)],
      errors: [],
    });
  });

  it("names the missing operator and the unreadable scope", () => {
    expect(evaluateAutonomy(runtime, all(), { repo: "" }, "work.send", facts({ operator: "" }))).toEqual({
      decision: "deny",
      reasons: [],
      errors: [
        "The scope must be { label } or { repo, paths } with at least one path.",
        "The scope has no operator. Oxagen acts only as a scope's operator.",
      ],
    });
  });

  function stub(isAuthorized: () => unknown): CedarRuntime {
    return { ...runtime, isAuthorized } as unknown as CedarRuntime;
  }

  it("denies with Cedar's errors when Cedar refuses the request", () => {
    const refused = stub(() => ({ type: "failure", errors: [{ message: "unknown entity type" }], warnings: [] }));
    expect(evaluateAutonomy(refused, all(), DOCS, "work.send", facts())).toEqual({
      decision: "deny",
      reasons: [],
      errors: ["unknown entity type"],
    });
  });

  it("denies when a policy fails to evaluate, even if Cedar answered allow", () => {
    const failed = stub(() => ({
      type: "success",
      response: {
        decision: "allow",
        diagnostics: {
          reason: ["work.send/label:Documentation", "a-policy"],
          errors: [{ policyId: "work.merge/high-risk", error: { message: "integer overflow" } }],
        },
      },
      warnings: [],
    }));
    expect(evaluateAutonomy(failed, all(), DOCS, "work.send", facts())).toEqual({
      decision: "deny",
      reasons: ["a-policy", "work.send/label:Documentation"],
      errors: ["work.merge/high-risk: integer overflow"],
    });
  });

  it.each([
    ["an Error", new Error("wasm trapped"), "wasm trapped"],
    ["a value that is not an Error", "wasm trapped", "wasm trapped"],
  ])("denies when the evaluator throws %s", (_name, thrown, message) => {
    const throwing = stub(() => {
      throw thrown;
    });
    expect(evaluateAutonomy(throwing, all(), DOCS, "work.send", facts())).toEqual({
      decision: "deny",
      reasons: [],
      errors: [`Cedar could not evaluate the request: ${message}`],
    });
  });
});
