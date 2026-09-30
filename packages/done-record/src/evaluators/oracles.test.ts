// oracles.test.ts: each day-one oracle class stamps one fixture and rejects
// another, a class with no evaluator returns nothing, and a crash or a missing
// fixture is a rejection with its own code.
import { digestJcs } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import {
  evaluateBudget,
  evaluateExample,
  evaluateExecutable,
  evaluateOracle,
  evaluatePolicy,
  evaluatePredicate,
  evaluateProvenance,
  evaluateSchema,
  hasOracleEvaluator,
  resolvePointer,
} from "./oracles";
import {
  DAY_ONE_ORACLE_CLASSES,
  type BudgetLimits,
  type DayOneOracleClass,
  type GatewayRecords,
  type OracleFixture,
  type RunRecord,
  type Trace,
  type UsageRecord,
} from "./types";

const OUT = digestJcs("stdout");
const ERR = digestJcs("stderr");
const CHUNK_A = digestJcs("chunk a");
const CHUNK_B = digestJcs("chunk b");
const PRE = digestJcs("pre-state");
const ART_1 = digestJcs("artifact 1");
const ART_2 = digestJcs("artifact 2");

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

interface ClassCase {
  fixture: OracleFixture;
  pass: Trace;
  fail: Trace;
  reason: string;
}

// One passing and one failing trace for every day-one class. The Record type
// makes the compiler refuse a class with no case.
const CASES: Record<DayOneOracleClass, ClassCase> = {
  example: {
    fixture: { class: "example", output: "total", expected: { cents: 1200 } },
    pass: trace({ outputs: { total: { cents: 1200 } } }),
    fail: trace({ outputs: { total: { cents: 1199 } } }),
    reason: "POST_MISMATCH",
  },
  predicate: {
    fixture: {
      class: "predicate",
      assertions: [{ path: "/orders/0/state", equals: "paid" }],
    },
    pass: trace({ snapshot: { orders: [{ state: "paid" }] } }),
    fail: trace({ snapshot: { orders: [{ state: "open" }] } }),
    reason: "POST_MISMATCH",
  },
  schema: {
    fixture: {
      class: "schema",
      output: "user",
      schema: {
        type: "object",
        required: ["email"],
        properties: { email: { type: "string", format: "email" } },
      },
    },
    pass: trace({ outputs: { user: { email: "a@example.com" } } }),
    fail: trace({ outputs: { user: { email: "not an email" } } }),
    reason: "SCHEMA_INVALID",
  },
  executable: {
    fixture: { class: "executable", command: "pnpm test:unit" },
    pass: trace({ runs: { "pnpm test:unit": run() } }),
    fail: trace({ runs: { "pnpm test:unit": run({ exitCode: 1 }) } }),
    reason: "EXEC_FAILED",
  },
  policy: {
    fixture: { class: "policy", capabilities: ["Read", "Bash(pnpm *)"] },
    pass: trace({
      gateway: gateway({
        toolCalls: [
          { tool: "Read", input: { file_path: "src/a.ts" } },
          { tool: "Bash", input: { command: "pnpm lint" } },
        ],
      }),
    }),
    fail: trace({
      gateway: gateway({
        toolCalls: [{ tool: "Bash", input: { command: "curl x" } }],
      }),
    }),
    reason: "POLICY_VIOLATION",
  },
  budget: {
    fixture: { class: "budget", limits: { usd: 2, tokens: 10_000 } },
    pass: trace({ gateway: gateway({ usage: usage({ usd: 2, tokens: 900 }) }) }),
    fail: trace({ gateway: gateway({ usage: usage({ usd: 2.01 }) }) }),
    reason: "BUDGET_EXCEEDED",
  },
  provenance: {
    fixture: { class: "provenance" },
    pass: trace({
      retrieved: [{ id: "doc-1#3", sha256: CHUNK_A }],
      citations: [{ chunk: "doc-1#3", sha256: CHUNK_A }],
    }),
    fail: trace({
      retrieved: [{ id: "doc-1#3", sha256: CHUNK_A }],
      citations: [{ chunk: "doc-1#4", sha256: CHUNK_A }],
    }),
    reason: "PROVENANCE_MISSING",
  },
};

describe("every day-one oracle class", () => {
  it.each(DAY_ONE_ORACLE_CLASSES.map((cls) => [cls]))(
    "%s stamps its passing fixture and rejects its failing one",
    (cls) => {
      const { fixture, pass, fail, reason } = CASES[cls];
      const oracle = { class: cls };
      expect(evaluateOracle(oracle, fixture, pass)).toEqual({
        ok: true,
        evidence: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      });
      const rejected = evaluateOracle(oracle, fixture, fail);
      expect(rejected).toMatchObject({ ok: false, reason });
      expect(rejected?.error).toBeUndefined();
    },
  );
});

describe("example", () => {
  it("compares by digest when the fixture stores only the digest", () => {
    const fixture = {
      class: "example" as const,
      output: "o",
      expectedDigest: digestJcs([1, 2]),
    };
    expect(evaluateExample(fixture, trace({ outputs: { o: [1, 2] } })).ok).toBe(true);
    expect(evaluateExample(fixture, trace({ outputs: { o: [2, 1] } })).reason).toBe(
      "POST_MISMATCH",
    );
  });

  it("rejects when the output is absent", () => {
    const fixture = { class: "example" as const, output: "o", expected: null };
    expect(evaluateExample(fixture, trace()).reason).toBe("POST_MISMATCH");
    expect(evaluateExample(fixture, trace({ outputs: { o: null } })).ok).toBe(true);
  });

  it("cannot decide without an expected value", () => {
    const fixture = { class: "example" as const, output: "o" };
    expect(evaluateExample(fixture, trace({ outputs: { o: 1 } }))).toMatchObject({
      ok: false,
      error: true,
      reason: "FIXTURE_MISSING",
    });
  });
});

describe("resolvePointer", () => {
  const doc = { a: { "b/c": [10, { "d~e": true }] }, n: null };

  it("resolves the whole document, keys, indexes, and escaped tokens", () => {
    expect(resolvePointer(doc, "")).toEqual({ found: true, value: doc });
    expect(resolvePointer(doc, "/a/b~1c/0")).toEqual({ found: true, value: 10 });
    expect(resolvePointer(doc, "/a/b~1c/1/d~0e")).toEqual({ found: true, value: true });
    expect(resolvePointer(doc, "/n")).toEqual({ found: true, value: null });
  });

  it("finds nothing past the end of the document", () => {
    expect(resolvePointer(doc, "/missing")).toEqual({ found: false });
    expect(resolvePointer(doc, "/a/b~1c/2")).toEqual({ found: false });
    expect(resolvePointer(doc, "/a/b~1c/01")).toEqual({ found: false });
    expect(resolvePointer(doc, "/a/b~1c/x")).toEqual({ found: false });
    expect(resolvePointer(doc, "/a/b~1c/0/deeper")).toEqual({ found: false });
    expect(resolvePointer(doc, "/n/x")).toEqual({ found: false });
  });

  it("throws on text that is not a pointer", () => {
    expect(() => resolvePointer(doc, "a")).toThrow(TypeError);
  });
});

describe("predicate", () => {
  const snapshot = { rows: [{ id: 1 }, { id: 2 }], flag: false };

  it("checks presence, absence, equality, and count", () => {
    const fixture = {
      class: "predicate" as const,
      assertions: [
        { path: "/flag" },
        { path: "/deleted", exists: false },
        { path: "/rows/1/id", equals: 2 },
        { path: "/rows", count: 2 },
      ],
    };
    expect(evaluatePredicate(fixture, trace({ snapshot })).ok).toBe(true);
  });

  it("rejects a missing path, a present path that must be absent, and a wrong count", () => {
    const at = (assertion: { path: string; exists?: boolean; count?: number }) =>
      evaluatePredicate(
        { class: "predicate", assertions: [assertion] },
        trace({ snapshot }),
      ).reason;
    expect(at({ path: "/deleted" })).toBe("POST_MISMATCH");
    expect(at({ path: "/flag", exists: false })).toBe("POST_MISMATCH");
    expect(at({ path: "/rows", count: 3 })).toBe("POST_MISMATCH");
    expect(at({ path: "/flag", count: 0 })).toBe("POST_MISMATCH");
  });

  it("cannot decide without a snapshot or an assertion", () => {
    const one = { class: "predicate" as const, assertions: [{ path: "/flag" }] };
    expect(evaluatePredicate(one, trace())).toMatchObject({
      error: true,
      reason: "FIXTURE_MISSING",
    });
    const none = { class: "predicate" as const, assertions: [] };
    expect(evaluatePredicate(none, trace({ snapshot }))).toMatchObject({
      error: true,
      reason: "FIXTURE_MISSING",
    });
  });
});

describe("schema", () => {
  it("rejects an output that is absent", () => {
    const fixture = { class: "schema" as const, output: "o", schema: true };
    expect(evaluateSchema(fixture, trace()).reason).toBe("SCHEMA_INVALID");
    expect(evaluateSchema(fixture, trace({ outputs: { o: 1 } })).ok).toBe(true);
  });

  it("refuses to fetch a remote $ref", () => {
    const fixture = {
      class: "schema" as const,
      output: "o",
      schema: { $ref: "https://example.com/remote.json" },
    };
    expect(() => evaluateSchema(fixture, trace({ outputs: { o: 1 } }))).toThrow();
    expect(
      evaluateOracle({ class: "schema" }, fixture, trace({ outputs: { o: 1 } })),
    ).toMatchObject({ ok: false, error: true, reason: "EVALUATOR_ERROR" });
  });
});

describe("executable", () => {
  const fixture = { class: "executable" as const, command: "make check", timeout_s: 30 };

  it("cannot decide a command the runtime never ran", () => {
    expect(evaluateExecutable(fixture, trace())).toMatchObject({
      error: true,
      reason: "FIXTURE_MISSING",
    });
  });

  it("rejects a command that was killed or ran past its timeout", () => {
    const at = (record: RunRecord) =>
      evaluateExecutable(fixture, trace({ runs: { "make check": record } }));
    expect(at(run({ durationS: 31 }))).toMatchObject({ error: true, reason: "EXEC_FAILED" });
    expect(at(run({ signal: "SIGTERM" }))).toMatchObject({ error: true, reason: "EXEC_FAILED" });
    expect(at(run({ exitCode: null }))).toMatchObject({ error: true, reason: "EXEC_FAILED" });
    expect(at(run({ durationS: 30 })).ok).toBe(true);
  });

  it("gives an unset timeout 600 seconds", () => {
    const loose = { class: "executable" as const, command: "make check" };
    const at = (durationS: number) =>
      evaluateExecutable(loose, trace({ runs: { "make check": run({ durationS }) } })).ok;
    expect(at(600)).toBe(true);
    expect(at(601)).toBe(false);
  });
});

describe("policy", () => {
  it("passes a run with no tool calls", () => {
    expect(evaluatePolicy({ class: "policy", capabilities: [] }, trace()).ok).toBe(true);
  });

  it("rejects a call to a tool outside the set", () => {
    const t = trace({
      gateway: gateway({ toolCalls: [{ tool: "WebFetch", input: { url: "x" } }] }),
    });
    expect(evaluatePolicy({ class: "policy", capabilities: ["Read"] }, t).reason).toBe(
      "POLICY_VIOLATION",
    );
  });
});

describe("budget", () => {
  const used = usage({ usd: 1, tokens: 500, minutes: 10, toolCalls: 20, retries: 2 });

  it("rejects each counter over its limit", () => {
    const t = trace({ gateway: gateway({ usage: used }) });
    const over = (limits: BudgetLimits) =>
      evaluateBudget({ class: "budget", limits }, t).reason;
    expect(over({ usd: 0.5 })).toBe("BUDGET_EXCEEDED");
    expect(over({ tokens: 499 })).toBe("BUDGET_EXCEEDED");
    expect(over({ minutes: 9 })).toBe("BUDGET_EXCEEDED");
    expect(over({ tool_calls: 19 })).toBe("BUDGET_EXCEEDED");
    expect(over({ retries: 1 })).toBe("BUDGET_EXCEEDED");
    expect(
      evaluateBudget(
        { class: "budget", limits: { usd: 1, tokens: 500, minutes: 10, tool_calls: 20, retries: 2 } },
        t,
      ).ok,
    ).toBe(true);
  });

  it("cannot decide a cost limit when the gateway reported no cost", () => {
    const t = trace({ gateway: gateway({ usage: usage({ usd: null }) }) });
    expect(evaluateBudget({ class: "budget", limits: { usd: 5 } }, t)).toMatchObject({
      ok: false,
      error: true,
      reason: "EVALUATOR_ERROR",
    });
    expect(evaluateBudget({ class: "budget", limits: { tokens: 5 } }, t).ok).toBe(true);
  });

  it("reports an exceeded limit before an undecided one", () => {
    const t = trace({ gateway: gateway({ usage: usage({ usd: null, minutes: 9 }) }) });
    const result = evaluateBudget({ class: "budget", limits: { usd: 5, minutes: 1 } }, t);
    expect(result.reason).toBe("BUDGET_EXCEEDED");
    expect(result.error).toBeUndefined();
  });
});

describe("provenance", () => {
  it("chains artifacts to retrieved chunks, fixture inputs, and earlier artifacts", () => {
    const t = trace({
      retrieved: [{ id: "a", sha256: CHUNK_A }],
      artifacts: [
        { id: "one", sha256: ART_1, inputs: [CHUNK_A, PRE] },
        { id: "two", sha256: ART_2, inputs: [ART_1] },
      ],
    });
    expect(evaluateProvenance({ class: "provenance", inputs: [PRE] }, t).ok).toBe(true);
    expect(evaluateProvenance({ class: "provenance" }, t).reason).toBe(
      "PROVENANCE_MISSING",
    );
  });

  it("rejects an artifact with no inputs or one that chains to a later artifact", () => {
    const empty = trace({ artifacts: [{ id: "one", sha256: ART_1, inputs: [] }] });
    expect(evaluateProvenance({ class: "provenance" }, empty).reason).toBe(
      "PROVENANCE_MISSING",
    );
    const forward = trace({
      retrieved: [{ id: "b", sha256: CHUNK_B }],
      artifacts: [
        { id: "one", sha256: ART_1, inputs: [ART_2] },
        { id: "two", sha256: ART_2, inputs: [CHUNK_B] },
      ],
    });
    expect(evaluateProvenance({ class: "provenance" }, forward).reason).toBe(
      "PROVENANCE_MISSING",
    );
  });

  it("rejects a citation whose hash does not match the retrieved chunk", () => {
    const t = trace({
      retrieved: [{ id: "a", sha256: CHUNK_A }],
      citations: [{ chunk: "a", sha256: CHUNK_B }],
    });
    expect(evaluateProvenance({ class: "provenance" }, t).reason).toBe(
      "PROVENANCE_MISSING",
    );
  });
});

describe("evaluateOracle", () => {
  it("returns nothing for a class with no evaluator, so the criterion stays held", () => {
    expect(hasOracleEvaluator("invariant")).toBe(false);
    expect(hasOracleEvaluator("example")).toBe(true);
    const fixture = CASES.example.fixture;
    expect(evaluateOracle({ class: "invariant" }, fixture, trace())).toBeUndefined();
    expect(evaluateOracle({ class: "formal" }, undefined, trace())).toBeUndefined();
  });

  it("rejects with FIXTURE_MISSING when the fixture is absent or of another class", () => {
    expect(evaluateOracle({ class: "example" }, undefined, trace())).toMatchObject({
      ok: false,
      error: true,
      reason: "FIXTURE_MISSING",
    });
    expect(
      evaluateOracle({ class: "schema" }, CASES.example.fixture, trace()),
    ).toMatchObject({ ok: false, error: true, reason: "FIXTURE_MISSING" });
  });

  it("rejects with EVALUATOR_ERROR when the evaluator throws", () => {
    const bad = { class: "predicate" as const, assertions: [{ path: "no-slash" }] };
    expect(evaluateOracle({ class: "predicate" }, bad, trace({ snapshot: {} }))).toMatchObject({
      ok: false,
      error: true,
      reason: "EVALUATOR_ERROR",
    });
  });

  it("rejects with EVALUATOR_ERROR when the evaluator throws something that is not an Error", () => {
    const outputs = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          // A string, not an Error, is what this test throws.
          throw "boom";
        },
      },
    );
    const result = evaluateOracle(
      { class: "example" },
      CASES.example.fixture,
      trace({ outputs }),
    );
    expect(result).toMatchObject({ ok: false, error: true, reason: "EVALUATOR_ERROR" });
    expect(result?.evidence).toBe(digestJcs({ class: "example", error: "thrown" }));
  });
});
