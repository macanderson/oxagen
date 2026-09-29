// criterion.test.ts: one criterion's check, oracle, and negative. Every
// negative runs, and a criterion whose negative passes is broken.
import { digestJcs } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import type { Criterion } from "../types";
import { evaluateCriterion, negativeTrace } from "./criterion";
import type {
  CriterionFixtures,
  GatewayRecords,
  RunRecord,
  Trace,
  UsageRecord,
} from "./types";

const OUT = digestJcs("stdout");
const ERR = digestJcs("stderr");

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    usd: 0,
    tokens: 0,
    toolCalls: 0,
    minutes: 0,
    retries: 0,
    stopAttempts: 0,
    ...overrides,
  };
}

function gateway(overrides: Partial<GatewayRecords> = {}): GatewayRecords {
  return {
    tier: "contained",
    basis: "gateway_observed",
    toolCalls: [],
    usage: usage(),
    ...overrides,
  };
}

function trace(overrides: Partial<Trace> = {}): Trace {
  return {
    runs: {},
    files: {},
    outputs: {},
    retrieved: [],
    citations: [],
    artifacts: [],
    gateway: gateway(),
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { exitCode: 0, durationS: 5, stdout: OUT, stderr: ERR, ...overrides };
}

const CMD = "pnpm test:unit";
const green = trace({ runs: { [CMD]: run() }, outputs: { total: 1200 } });

const tests: Criterion = {
  id: "tests-pass",
  text: "The unit tests pass",
  tag: "test",
  check: { run: CMD },
  negative: "The same tests with the fix reverted exit nonzero",
};

const total: Criterion = {
  id: "total-matches",
  text: "The invoice total is 1200 cents",
  tag: "code",
  oracle: { class: "example" },
  negative: "A total of 1199 cents",
};

const exampleFixture: CriterionFixtures["oracle"] = {
  class: "example",
  output: "total",
  expected: 1200,
};

describe("a criterion with no negative", () => {
  it("runs the check and the oracle and reports no negative", () => {
    const criterion: Criterion = { ...tests, oracle: { class: "example" } };
    delete criterion.negative;
    const result = evaluateCriterion({
      criterion,
      trace: green,
      fixtures: { oracle: exampleFixture },
      runOracle: true,
    });
    expect(result.check?.ok).toBe(true);
    expect(result.oracle?.ok).toBe(true);
    expect(result.oracleStatus).toBe("ran");
    expect(result.negative).toEqual({ status: "none" });
  });

  it("reports a criterion with neither check nor oracle", () => {
    const criterion: Criterion = { id: "note", text: "A note", tag: "docs" };
    const result = evaluateCriterion({ criterion, trace: green, runOracle: true });
    expect(result).toEqual({
      id: "note",
      oracleStatus: "none",
      negative: { status: "none" },
    });
  });
});

describe("the oracle status", () => {
  it("is not-run when the stage may not run oracles", () => {
    const result = evaluateCriterion({
      criterion: total,
      trace: green,
      fixtures: { oracle: exampleFixture, negative: { outputs: { total: 1199 } } },
      runOracle: false,
    });
    expect(result.oracleStatus).toBe("not-run");
    expect(result.oracle).toBeUndefined();
    expect(result.negative.status).toBe("unrunnable");
  });

  it("is unbuilt for a class with no evaluator, so the criterion stays held", () => {
    const criterion: Criterion = { ...total, oracle: { class: "differential" } };
    const result = evaluateCriterion({
      criterion,
      trace: green,
      fixtures: { negative: { outputs: { total: 1199 } } },
      runOracle: true,
    });
    expect(result.oracleStatus).toBe("unbuilt");
    expect(result.oracle).toBeUndefined();
    expect(result.negative.status).toBe("unrunnable");
  });
});

describe("the negative", () => {
  it("is rejected by the check, as it must be", () => {
    const result = evaluateCriterion({
      criterion: tests,
      trace: green,
      fixtures: { negative: { runs: { [CMD]: run({ exitCode: 1 }) } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("rejected");
    expect(result.negative.evidence).toMatch(/^sha256:/);
    expect(result.check).toMatchObject({ ok: true });
  });

  it("is rejected by the oracle, as it must be", () => {
    const result = evaluateCriterion({
      criterion: total,
      trace: green,
      fixtures: { oracle: exampleFixture, negative: { outputs: { total: 1199 } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("rejected");
    expect(result.oracle).toMatchObject({ ok: true });
  });

  it("gives the same evidence for the same inputs", () => {
    const input = {
      criterion: tests,
      trace: green,
      fixtures: { negative: { runs: { [CMD]: run({ exitCode: 1 }) } } },
      runOracle: true,
    };
    expect(evaluateCriterion(input).negative.evidence).toBe(
      evaluateCriterion(input).negative.evidence,
    );
  });
});

describe("a criterion whose negative passes is broken", () => {
  it("fails the check when the check passes its negative", () => {
    const result = evaluateCriterion({
      criterion: tests,
      trace: green,
      // The negative trace is as green as the real one, so the check cannot
      // tell them apart.
      fixtures: { negative: { runs: { [CMD]: run() } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("passed");
    expect(result.check).toMatchObject({ ok: false, reason: "CHECK_FAILED" });
    expect(result.check?.error).toBeUndefined();
  });

  it("fails the oracle when the oracle passes its negative", () => {
    const result = evaluateCriterion({
      criterion: total,
      trace: green,
      fixtures: { oracle: exampleFixture, negative: { outputs: { total: 1200 } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("passed");
    expect(result.oracle).toMatchObject({ ok: false, reason: "EVALUATOR_ERROR" });
    expect(result.oracle?.error).toBeUndefined();
  });

  it("is broken when either evaluator passes the negative", () => {
    const both: Criterion = { ...tests, oracle: { class: "example" } };
    const result = evaluateCriterion({
      criterion: both,
      trace: green,
      // The check rejects this trace, but the oracle passes it.
      fixtures: {
        oracle: exampleFixture,
        negative: { runs: { [CMD]: run({ exitCode: 1 }) } },
      },
      runOracle: true,
    });
    expect(result.negative.status).toBe("passed");
    expect(result.check).toMatchObject({ ok: true });
    expect(result.oracle).toMatchObject({ ok: false, reason: "EVALUATOR_ERROR" });
  });

  it("keeps a failing check's own reason", () => {
    // No record of the command, so the check itself could not decide.
    const unread = trace({ runs: {} });
    const positive = evaluateCriterion({
      criterion: { ...tests, negative: undefined },
      trace: unread,
      runOracle: true,
    }).check;
    const result = evaluateCriterion({
      criterion: tests,
      trace: unread,
      fixtures: { negative: { runs: { [CMD]: run() } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("passed");
    expect(result.check).toEqual(positive);
    expect(result.check).toMatchObject({ ok: false, error: true, reason: "HARNESS_ERROR" });
  });
});

describe("a negative that cannot be decided", () => {
  it("is an error when an evaluator cannot read the negative trace, and nothing passes", () => {
    const result = evaluateCriterion({
      criterion: tests,
      trace: green,
      // No record of the command: the check cannot decide.
      fixtures: { negative: { runs: {} } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("error");
    expect(result.check).toMatchObject({ ok: false, error: true, reason: "HARNESS_ERROR" });
  });

  it("is an error when the oracle cannot decide either trace", () => {
    const result = evaluateCriterion({
      criterion: total,
      trace: green,
      // The fixture is for another class, so the example oracle cannot run.
      fixtures: {
        oracle: { class: "predicate", assertions: [{ path: "/total", equals: 1200 }] },
        negative: { outputs: { total: 1199 } },
      },
      runOracle: true,
    });
    expect(result.oracle).toMatchObject({ ok: false, error: true, reason: "FIXTURE_MISSING" });
    expect(result.negative.status).toBe("error");
  });

  it("folds an oracle error on the negative into an oracle error", () => {
    const criterion: Criterion = { ...total, oracle: { class: "predicate" } };
    const result = evaluateCriterion({
      criterion,
      trace: trace({ snapshot: { total: 1200 } }),
      fixtures: {
        oracle: { class: "predicate", assertions: [{ path: "/total", equals: 1200 }] },
        negative: { snapshot: undefined },
      },
      runOracle: true,
    });
    expect(result.negative.status).toBe("error");
    expect(result.oracle).toMatchObject({ ok: false, error: true, reason: "EVALUATOR_ERROR" });
  });

  it("is missing when the fixtures give no negative trace", () => {
    const both: Criterion = { ...tests, oracle: { class: "example" } };
    const result = evaluateCriterion({
      criterion: both,
      trace: green,
      fixtures: { oracle: exampleFixture },
      runOracle: true,
    });
    expect(result.negative).toEqual({ status: "missing" });
    expect(result.check).toMatchObject({ ok: false, error: true, reason: "HARNESS_ERROR" });
    expect(result.oracle).toMatchObject({ ok: false, error: true, reason: "FIXTURE_MISSING" });
  });

  it("is unrunnable when only a person can decide the criterion", () => {
    const signed: Criterion = {
      id: "reviewed",
      text: "Mac reviewed the change",
      tag: "review",
      check: { human: "mac" },
      negative: "An unsigned change",
    };
    const result = evaluateCriterion({
      criterion: signed,
      trace: green,
      signature: { by: "mac", at: "2026-09-29T12:00:00Z" },
      fixtures: { negative: {} },
      runOracle: true,
    });
    expect(result.negative.status).toBe("unrunnable");
    expect(result.check?.ok).toBe(true);
  });

  it("runs only the oracle when the check is a person's", () => {
    const signed: Criterion = {
      ...total,
      check: { human: "mac" },
    };
    const result = evaluateCriterion({
      criterion: signed,
      trace: green,
      fixtures: { oracle: exampleFixture, negative: { outputs: { total: 1 } } },
      runOracle: true,
    });
    expect(result.negative.status).toBe("rejected");
    expect(result.check).toMatchObject({ ok: false, reason: "HUMAN_PENDING" });
    expect(result.oracle?.ok).toBe(true);
  });
});

describe("negativeTrace", () => {
  it("replaces only the parts the negative names", () => {
    const against = negativeTrace(green, { outputs: { total: 1 } });
    expect(against.outputs).toEqual({ total: 1 });
    expect(against.runs).toBe(green.runs);
    expect(against.gateway).toBe(green.gateway);
  });
});

describe("a check and an oracle in two runtimes", () => {
  it("runs the check on the build trace and the oracle on the verify trace", () => {
    const both: Criterion = { ...tests, oracle: { class: "example" } };
    // The build trace has the wrong total and the verify trace has no run, so
    // each evaluator passes only when it reads its own trace.
    const build = trace({ runs: { [CMD]: run() }, outputs: { total: 7 } });
    const verify = trace({ outputs: { total: 1200 } });
    const result = evaluateCriterion({
      criterion: both,
      trace: build,
      oracleTrace: verify,
      fixtures: {
        oracle: exampleFixture,
        negative: { runs: { [CMD]: run({ exitCode: 1 }) }, outputs: { total: 1199 } },
      },
      runOracle: true,
    });
    expect(result.check?.ok).toBe(true);
    expect(result.oracle?.ok).toBe(true);
    expect(result.negative.status).toBe("rejected");
  });
});
