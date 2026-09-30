// runner.test.ts: the verify stage runs every check against the build runtime's
// capture and every oracle against its own, runs every negative, reads tool
// calls and usage from the gateway's records, and hands decide the evidence.
// decide is injected, so each test reads exactly what the stage handed it.
import {
  type Criterion,
  type DoneEvidence,
  type DoneOutcome,
  type DoneRecord,
  type Fixtures,
  type GatewayRecords,
  type RunRecord,
  type TraceFacts,
  type UsageRecord,
  DONE_RECORD_SCHEMA,
} from "@oxagen/done-record";
import { digestJcs } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import {
  type StageRecords,
  type VerifyRefusal,
  type VerifyStageInput,
  VERIFY_REFUSALS,
  runVerifyStage,
  verifyRefusals,
} from "./runner";

const OUT = digestJcs("stdout");
const ERR = digestJcs("stderr");
const CMD = "pnpm test:unit";
const BUILD_MODEL = "anthropic/claude-sonnet";
const VERIFY_MODEL = "openai/gpt-verify";

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    usd: 2,
    tokens: 1000,
    toolCalls: 3,
    minutes: 10,
    retries: 0,
    stopAttempts: 1,
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

function stage(model: string, overrides: Partial<GatewayRecords> = {}): StageRecords {
  return { model, gateway: gateway(overrides) };
}

function facts(overrides: Partial<TraceFacts> = {}): TraceFacts {
  return {
    runs: {},
    files: {},
    outputs: {},
    retrieved: [],
    citations: [],
    artifacts: [],
    ...overrides,
  };
}

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return { exitCode: 0, durationS: 5, stdout: OUT, stderr: ERR, ...overrides };
}

function record(criteria: Criterion[], overrides: Partial<DoneRecord> = {}): DoneRecord {
  return {
    schema: DONE_RECORD_SCHEMA,
    item: "wi_verify",
    lineage: "gh:macanderson/oxagen#1",
    criteria,
    ...overrides,
  };
}

/** A decide that records what it was handed and holds every criterion. */
function recorder() {
  const seen: DoneEvidence[] = [];
  const decide = (evidence: DoneEvidence): DoneOutcome => {
    seen.push(evidence);
    return {
      verdict: "held",
      reasons: [],
      criteria: evidence.criteria.map((entry) => ({ id: entry.id, state: "held" as const })),
    };
  };
  return { seen, decide };
}

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

const noFetch: Criterion = {
  id: "no-fetch",
  text: "The agent fetched no web page",
  tag: "code",
  check: { tools: { deny: ["WebFetch"] } },
  negative: "A run that fetched a page",
};

const withinBudget: Criterion = {
  id: "within-budget",
  text: "The work cost at most five dollars",
  tag: "code",
  check: { budget: { usd: 5 } },
  negative: "A run that cost six dollars",
};

const stayedInPolicy: Criterion = {
  id: "stayed-in-policy",
  text: "The agent only read and edited files",
  tag: "code",
  oracle: { class: "policy" },
};

const reviewed: Criterion = {
  id: "reviewed",
  text: "Mac reviewed the change",
  tag: "review",
  check: { human: "mac" },
};

const note: Criterion = { id: "note", text: "The release note reads well", tag: "docs" };

const FETCH = { tool: "WebFetch", input: { url: "https://example.com" } };

const fixtures: Fixtures = {
  [tests.id]: { negative: { runs: { [CMD]: run({ exitCode: 1 }) } } },
  [total.id]: {
    oracle: { class: "example", output: "total", expected: 1200 },
    negative: { outputs: { total: 1199 } },
  },
  [noFetch.id]: { negative: { gateway: gateway({ toolCalls: [FETCH] }) } },
  [withinBudget.id]: { negative: { gateway: gateway({ usage: usage({ usd: 6 }) }) } },
  [stayedInPolicy.id]: { oracle: { class: "policy", capabilities: ["Read", "Edit"] } },
};

const SIGNED = { by: "mac", at: "2026-09-29T12:00:00Z" };

function input(overrides: Partial<VerifyStageInput> = {}): VerifyStageInput {
  return {
    record: record([tests, total]),
    buildFacts: facts({ runs: { [CMD]: run() } }),
    verifyFacts: facts({ outputs: { total: 1200 } }),
    fixtures,
    build: [stage(BUILD_MODEL)],
    verify: stage(VERIFY_MODEL),
    ...overrides,
  };
}

function entry(evidence: DoneEvidence, id: string) {
  return evidence.criteria.find((criterion) => criterion.id === id);
}

describe("runVerifyStage", () => {
  it("hands decide one entry per criterion and returns what decide said", () => {
    const deps = recorder();
    const result = runVerifyStage(
      input({ claims: { [tests.id]: "agent-7" } }),
      deps,
    );
    expect(deps.seen).toHaveLength(1);
    expect(result.evidence).toBe(deps.seen[0]);
    expect(result.outcome).toEqual({
      verdict: "held",
      reasons: [],
      criteria: [
        { id: tests.id, state: "held" },
        { id: total.id, state: "held" },
      ],
    });
    expect(result.refusals).toEqual([]);
    expect(result.broken).toEqual([]);
    expect(result.criteria.map((criterion) => criterion.negative.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(entry(result.evidence, tests.id)).toEqual({
      id: tests.id,
      claimedBy: "agent-7",
      check: { ok: true, evidence: result.criteria[0]?.check?.evidence },
    });
    expect(entry(result.evidence, total.id)).toEqual({
      id: total.id,
      oracle: {
        ok: true,
        evidence: result.criteria[1]?.oracle?.evidence,
        contained: true,
        model: VERIFY_MODEL,
      },
    });
    expect(result.evidence.models).toEqual({ build: [BUILD_MODEL] });
    expect(result.evidence.usage).toEqual({ usd: 2, toolCalls: 3, minutes: 10, stopAttempts: 1 });
    expect(result.evidence.denials).toBeUndefined();
  });

  it("runs checks on the build capture and oracles on the verify capture", () => {
    // The build capture has the wrong total and the verify capture has no run,
    // so each passes only when read by its own evaluator.
    const result = runVerifyStage(
      input({
        buildFacts: facts({ runs: { [CMD]: run() }, outputs: { total: 7 } }),
        verifyFacts: facts({ outputs: { total: 1200 } }),
      }),
      recorder(),
    );
    expect(result.criteria[0]?.check?.ok).toBe(true);
    expect(result.criteria[1]?.oracle?.ok).toBe(true);
  });

  it("puts only run, file, and diff results in the check slot", () => {
    const readme: Criterion = {
      id: "readme",
      text: "The README exists",
      tag: "docs",
      check: { file: { path: "README.md" } },
    };
    const scoped: Criterion = {
      id: "scoped",
      text: "Only package files changed",
      tag: "code",
      check: { diff: { allow: ["packages/**"] } },
    };
    const result = runVerifyStage(
      input({
        record: record([tests, readme, scoped, noFetch, withinBudget, reviewed]),
        buildFacts: facts({
          runs: { [CMD]: run() },
          files: { "README.md": { sha256: digestJcs("readme") } },
          diff: { base: "abc123", files: ["packages/work/src/a.ts"] },
        }),
      }),
      recorder(),
    );
    const withCheck = result.evidence.criteria
      .filter((criterion) => criterion.check !== undefined)
      .map((criterion) => criterion.id);
    expect(withCheck).toEqual([tests.id, readme.id, scoped.id]);
    expect(result.evidence.criteria.every((criterion) => criterion.check?.ok !== false)).toBe(true);
  });

  it("carries a check the harness could not run as an error", () => {
    const result = runVerifyStage(input({ buildFacts: facts() }), recorder());
    expect(entry(result.evidence, tests.id)?.check).toEqual({
      ok: false,
      evidence: result.criteria[0]?.check?.evidence,
      error: true,
    });
  });

  it("carries an oracle that could not decide as an error", () => {
    const result = runVerifyStage(
      input({ fixtures: { ...fixtures, [total.id]: { negative: { outputs: { total: 1 } } } } }),
      recorder(),
    );
    expect(entry(result.evidence, total.id)?.oracle).toEqual({
      ok: false,
      evidence: result.criteria[1]?.oracle?.evidence,
      error: true,
      contained: true,
      model: VERIFY_MODEL,
    });
  });

  it("gives a signature only to a criterion a person decides", () => {
    const signatures = {
      [tests.id]: SIGNED,
      [total.id]: SIGNED,
      [reviewed.id]: SIGNED,
      [note.id]: SIGNED,
    };
    const result = runVerifyStage(
      input({ record: record([tests, total, reviewed, note]), signatures }),
      recorder(),
    );
    const signed = result.evidence.criteria
      .filter((criterion) => criterion.signature !== undefined)
      .map((criterion) => criterion.id);
    expect(signed).toEqual([reviewed.id, note.id]);
  });

  it("names the drafting model when one drafted the record", () => {
    const result = runVerifyStage(input({ drafting: "google/gemini-draft" }), recorder());
    expect(result.evidence.models).toEqual({
      build: [BUILD_MODEL],
      drafting: "google/gemini-draft",
    });
  });

  it("refuses a stage with no build to judge", () => {
    expect(() => runVerifyStage(input({ build: [] }), recorder())).toThrow(TypeError);
  });
});

describe("tool calls and usage", () => {
  it("reads them from every build stage's gateway records", () => {
    const result = runVerifyStage(
      input({
        record: record([tests, noFetch, withinBudget]),
        build: [
          stage(BUILD_MODEL, { toolCalls: [FETCH] }),
          stage("anthropic/claude-haiku", { toolCalls: [FETCH], usage: usage({ usd: 1.5 }) }),
        ],
      }),
      recorder(),
    );
    // Two calls matched one rule, and decide reads each rule once.
    expect(result.evidence.denials).toEqual(["WebFetch"]);
    expect(result.evidence.usage).toEqual({ usd: 3.5, toolCalls: 6, minutes: 20, stopAttempts: 2 });
    expect(result.evidence.models.build).toEqual([BUILD_MODEL, "anthropic/claude-haiku"]);
  });

  it("reports no usage when a stage recorded no cost", () => {
    const result = runVerifyStage(
      input({ build: [stage(BUILD_MODEL, { usage: usage({ usd: null }) })] }),
      recorder(),
    );
    expect(result.evidence.usage).toBeUndefined();
  });

  it("reports no usage and runs no policy oracle when the worker counted the calls", () => {
    const result = runVerifyStage(
      input({
        record: record([total, stayedInPolicy]),
        build: [stage(BUILD_MODEL), stage("anthropic/claude-haiku", { basis: "client_attested" })],
      }),
      recorder(),
    );
    expect(result.refusals).toEqual(["build-not-gateway-observed"]);
    expect(result.evidence.usage).toBeUndefined();
    expect(result.criteria.map((criterion) => criterion.oracleStatus)).toEqual(["ran", "not-run"]);
    expect(entry(result.evidence, stayedInPolicy.id)).toEqual({ id: stayedInPolicy.id });
  });

  it("runs the policy oracle when the gateway counted every call", () => {
    const result = runVerifyStage(input({ record: record([stayedInPolicy]) }), recorder());
    expect(result.criteria[0]?.oracleStatus).toBe("ran");
    expect(entry(result.evidence, stayedInPolicy.id)?.oracle?.ok).toBe(true);
  });
});

describe("the verify stage's own runtime", () => {
  const cases: [string, Partial<VerifyStageInput>, VerifyRefusal][] = [
    ["is not contained", { verify: stage(VERIFY_MODEL, { tier: "gateway" }) }, "verify-not-contained"],
    [
      "was not observed by the gateway",
      { verify: stage(VERIFY_MODEL, { basis: "client_attested" }) },
      "verify-not-gateway-observed",
    ],
    ["has no recorded model", { verify: stage("") }, "verify-model-unrecorded"],
    ["reuses a build model", { verify: stage(BUILD_MODEL) }, "verify-model-reused-build"],
    ["reuses the drafting model", { drafting: VERIFY_MODEL }, "verify-model-reused-drafting"],
    [
      "reuses the model the record names as its drafter",
      { record: record([tests, total], { drafted_by: { model: VERIFY_MODEL, decision: "tri_1" } }) },
      "verify-model-reused-drafting",
    ],
  ];

  it.each(cases)("runs no oracle when it %s", (_name, overrides, refusal) => {
    const result = runVerifyStage(input(overrides), recorder());
    expect(result.refusals).toEqual([refusal]);
    expect(result.criteria[1]?.oracleStatus).toBe("not-run");
    expect(entry(result.evidence, total.id)).toEqual({ id: total.id });
    // A check runs where the build ran, so it still holds its criterion.
    expect(entry(result.evidence, tests.id)?.check?.ok).toBe(true);
  });

  it("names every refusal it can give", () => {
    expect(new Set(cases.map(([, , refusal]) => refusal))).toEqual(
      new Set(VERIFY_REFUSALS.filter((refusal) => refusal.startsWith("verify-"))),
    );
  });

  it("gives no refusal to a contained stage on a fresh model", () => {
    const refusals = verifyRefusals(
      { record: record([total]), build: [stage(BUILD_MODEL)], verify: stage(VERIFY_MODEL) },
      gateway(),
    );
    expect(refusals).toEqual([]);
  });
});

describe("a criterion whose negative passes is broken", () => {
  it("fails a run check whose negative passes, and names the criterion", () => {
    const result = runVerifyStage(
      input({ fixtures: { ...fixtures, [tests.id]: { negative: { runs: { [CMD]: run() } } } } }),
      recorder(),
    );
    expect(result.broken).toEqual([tests.id]);
    expect(entry(result.evidence, tests.id)?.check?.ok).toBe(false);
  });

  it("fails an oracle whose negative passes", () => {
    const result = runVerifyStage(
      input({
        fixtures: { ...fixtures, [total.id]: { ...fixtures[total.id], negative: { outputs: { total: 1200 } } } },
      }),
      recorder(),
    );
    expect(result.broken).toEqual([total.id]);
    expect(entry(result.evidence, total.id)?.oracle?.ok).toBe(false);
  });

  it("breaks the record when a tools check passes its negative, which decide cannot see", () => {
    // The negative trace has no denied call, so the tools check cannot tell it
    // from the real one.
    const result = runVerifyStage(
      input({
        record: record([tests, noFetch]),
        fixtures: { ...fixtures, [noFetch.id]: { negative: { gateway: gateway() } } },
      }),
      recorder(),
    );
    expect(result.broken).toEqual([noFetch.id]);
    expect(result.outcome).toEqual({
      verdict: "broken",
      reasons: [{ code: "CHECK_FAILED", criterion: noFetch.id }],
      criteria: [
        { id: tests.id, state: "held" },
        { id: noFetch.id, state: "failed" },
      ],
    });
  });

  it("breaks the record when a budget check passes its negative", () => {
    const result = runVerifyStage(
      input({
        record: record([withinBudget]),
        fixtures: { ...fixtures, [withinBudget.id]: { negative: { gateway: gateway() } } },
      }),
      recorder(),
    );
    expect(result.broken).toEqual([withinBudget.id]);
    expect(result.outcome.verdict).toBe("broken");
    expect(result.outcome.reasons).toEqual([{ code: "CHECK_FAILED", criterion: withinBudget.id }]);
  });

  it("breaks the record when a budget check has no negative to run", () => {
    const result = runVerifyStage(
      input({ record: record([withinBudget]), fixtures: {} }),
      recorder(),
    );
    expect(result.broken).toEqual([]);
    expect(result.criteria[0]?.negative.status).toBe("missing");
    expect(result.outcome.reasons).toEqual([{ code: "HARNESS_ERROR", criterion: withinBudget.id }]);
    expect(result.outcome.criteria).toEqual([{ id: withinBudget.id, state: "failed" }]);
  });

  it("leaves a tools check that fails on the real trace to decide", () => {
    const result = runVerifyStage(
      input({
        record: record([noFetch]),
        build: [stage(BUILD_MODEL, { toolCalls: [FETCH] })],
      }),
      recorder(),
    );
    // decide reads the denial and fails the criterion itself.
    expect(result.evidence.denials).toEqual(["WebFetch"]);
    expect(result.outcome).toEqual({
      verdict: "held",
      reasons: [],
      criteria: [{ id: noFetch.id, state: "held" }],
    });
  });

  it("leaves a tools check alone when its negative is rejected", () => {
    const result = runVerifyStage(input({ record: record([noFetch]) }), recorder());
    expect(result.criteria[0]?.negative.status).toBe("rejected");
    expect(result.outcome.verdict).toBe("held");
  });
});
