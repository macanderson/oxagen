// checks.test.ts: each of the six check kinds passes on one fixture and fails
// on another, and a check that cannot decide says so instead of passing.
import { digestJcs } from "@oxagen/run-evidence";
import { describe, expect, it } from "vitest";
import {
  deniedCalls,
  evaluateBudgetCheck,
  evaluateCheck,
  evaluateDiffCheck,
  evaluateFileCheck,
  evaluateHumanCheck,
  evaluateRunCheck,
  evaluateToolsCheck,
} from "./checks";
import type {
  GatewayRecords,
  RunRecord,
  ToolCallRecord,
  Trace,
  UsageRecord,
} from "./types";

const OUT = digestJcs("stdout");
const ERR = digestJcs("stderr");
const FILE = digestJcs("file");

function usage(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return { usd: 0, tokens: 0, toolCalls: 0, minutes: 0, retries: 0, stopAttempts: 0, ...overrides };
}

function gateway(overrides: Partial<GatewayRecords> = {}): GatewayRecords {
  return { tier: "contained", basis: "gateway_observed", toolCalls: [], usage: usage(), ...overrides };
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
  return { exitCode: 0, durationS: 12, stdout: OUT, stderr: ERR, ...overrides };
}

describe("run check", () => {
  const check = { run: "pnpm test" };

  it("passes when the command exited zero inside its timeout", () => {
    const result = evaluateRunCheck(check, trace({ runs: { "pnpm test": run() } }));
    expect(result).toEqual({ ok: true, evidence: expect.stringMatching(/^sha256:/) });
  });

  it("fails when the command exited nonzero", () => {
    const result = evaluateRunCheck(check, trace({ runs: { "pnpm test": run({ exitCode: 1 }) } }));
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CHECK_FAILED");
    expect(result.error).toBeUndefined();
  });

  it("cannot decide a command the runtime never ran", () => {
    expect(evaluateRunCheck(check, trace())).toMatchObject({
      ok: false,
      error: true,
      reason: "HARNESS_ERROR",
    });
  });

  it("cannot decide a command that ran past its timeout or was killed", () => {
    const late = trace({ runs: { "pnpm test": run({ durationS: 601 }) } });
    expect(evaluateRunCheck(check, late)).toMatchObject({ ok: false, error: true, reason: "HARNESS_ERROR" });
    const tight = trace({ runs: { "pnpm test": run({ durationS: 30 }) } });
    expect(evaluateRunCheck({ run: "pnpm test", timeout_s: 20 }, tight).reason).toBe("HARNESS_ERROR");
    const killed = trace({ runs: { "pnpm test": run({ exitCode: null, signal: "SIGKILL" }) } });
    expect(evaluateRunCheck(check, killed).reason).toBe("HARNESS_ERROR");
    const hung = trace({ runs: { "pnpm test": run({ exitCode: null }) } });
    expect(evaluateRunCheck(check, hung).reason).toBe("HARNESS_ERROR");
  });

  it("gives the same evidence for the same trace", () => {
    const t = trace({ runs: { "pnpm test": run() } });
    expect(evaluateRunCheck(check, t).evidence).toBe(evaluateRunCheck(check, t).evidence);
  });
});

describe("file check", () => {
  const files = { "src/a.ts": { sha256: FILE, text: "export const a = 1;" } };

  it("passes when the file exists", () => {
    expect(evaluateFileCheck({ file: { path: "src/a.ts" } }, trace({ files })).ok).toBe(true);
  });

  it("fails when the file is missing", () => {
    expect(evaluateFileCheck({ file: { path: "src/b.ts" } }, trace({ files }))).toMatchObject({
      ok: false,
      reason: "CHECK_FAILED",
    });
  });

  it("passes when a file that must be absent is absent, and fails when it is present", () => {
    expect(evaluateFileCheck({ file: { path: "src/b.ts", exists: false } }, trace({ files })).ok).toBe(true);
    expect(evaluateFileCheck({ file: { path: "src/a.ts", exists: false } }, trace({ files })).reason).toBe(
      "CHECK_FAILED",
    );
  });

  it("checks the digest", () => {
    expect(evaluateFileCheck({ file: { path: "src/a.ts", sha256: FILE } }, trace({ files })).ok).toBe(true);
    expect(
      evaluateFileCheck({ file: { path: "src/a.ts", sha256: digestJcs("other") } }, trace({ files })).reason,
    ).toBe("CHECK_FAILED");
  });

  it("checks that the text contains a string", () => {
    expect(evaluateFileCheck({ file: { path: "src/a.ts", contains: "const a" } }, trace({ files })).ok).toBe(true);
    expect(evaluateFileCheck({ file: { path: "src/a.ts", contains: "const b" } }, trace({ files })).reason).toBe(
      "CHECK_FAILED",
    );
  });

  it("cannot decide contains when the runtime captured no text", () => {
    const hashOnly = trace({ files: { "src/a.ts": { sha256: FILE } } });
    expect(evaluateFileCheck({ file: { path: "src/a.ts", contains: "x" } }, hashOnly)).toMatchObject({
      ok: false,
      error: true,
      reason: "HARNESS_ERROR",
    });
  });
});

describe("diff check", () => {
  const diff = { base: "abc123", files: ["src/a.ts", "src/b/c.ts", "docs/x.md"] };

  it("passes when every changed file is inside allow and outside deny", () => {
    const check = { diff: { allow: ["src/**", "docs/**/*.md"], deny: ["**/.env*"] } };
    expect(evaluateDiffCheck(check, trace({ diff })).ok).toBe(true);
  });

  it("allows every path when allow is not set", () => {
    expect(evaluateDiffCheck({ diff: {} }, trace({ diff })).ok).toBe(true);
  });

  it("fails when a changed file is outside allow", () => {
    expect(evaluateDiffCheck({ diff: { allow: ["src/**"] } }, trace({ diff })).reason).toBe("CHECK_FAILED");
  });

  it("fails when a changed file matches deny", () => {
    const withSecret = { base: "abc123", files: ["src/a.ts", "config/.env.local"] };
    expect(evaluateDiffCheck({ diff: { deny: ["**/.env*"] } }, trace({ diff: withSecret })).reason).toBe(
      "CHECK_FAILED",
    );
  });

  it("cannot decide without a diff manifest", () => {
    expect(evaluateDiffCheck({ diff: {} }, trace())).toMatchObject({ ok: false, error: true, reason: "HARNESS_ERROR" });
  });

  it("reads the files in a fixed order", () => {
    const reversed = { base: "abc123", files: [...diff.files].reverse() };
    expect(evaluateDiffCheck({ diff: {} }, trace({ diff: reversed })).evidence).toBe(
      evaluateDiffCheck({ diff: {} }, trace({ diff })).evidence,
    );
  });
});

describe("tools check", () => {
  const check = { tools: { deny: ["Bash(curl *)", "Read(**/.env*)"] } };

  it("passes when no recorded call matches a deny rule", () => {
    const calls: ToolCallRecord[] = [
      { tool: "Bash", input: { command: "pnpm test" } },
      { tool: "Read", input: { file_path: "src/a.ts" } },
    ];
    expect(evaluateToolsCheck(check, trace({ gateway: gateway({ toolCalls: calls }) })).ok).toBe(true);
  });

  it("fails with TOOL_DENIED when a recorded call matches a deny rule", () => {
    const calls: ToolCallRecord[] = [
      { tool: "Read", input: { file_path: "src/a.ts" } },
      { tool: "Read", input: { file_path: "app/.env" } },
    ];
    expect(evaluateToolsCheck(check, trace({ gateway: gateway({ toolCalls: calls }) }))).toMatchObject({
      ok: false,
      reason: "TOOL_DENIED",
    });
  });

  it("lists each denied call with the rule that matched it", () => {
    const calls: ToolCallRecord[] = [
      { tool: "Bash", input: { command: "cd x && curl http://example.com" } },
      { tool: "Bash", input: { command: "ls" } },
      { tool: "Read", input: { file_path: ".env" } },
    ];
    expect(deniedCalls(check.tools.deny, calls)).toEqual([
      { index: 0, tool: "Bash", rule: "Bash(curl *)" },
      { index: 2, tool: "Read", rule: "Read(**/.env*)" },
    ]);
  });
});

describe("budget check", () => {
  const within = gateway({ usage: usage({ usd: 1.5, toolCalls: 40, minutes: 12, stopAttempts: 1 }) });

  it("passes when every counter is at or under its limit", () => {
    const check = { budget: { usd: 1.5, tool_calls: 40, minutes: 12 } };
    expect(evaluateBudgetCheck(check, trace({ gateway: within })).ok).toBe(true);
  });

  it("fails with BUDGET_EXCEEDED when a counter is over its limit", () => {
    expect(evaluateBudgetCheck({ budget: { usd: 1 } }, trace({ gateway: within })).reason).toBe("BUDGET_EXCEEDED");
    expect(evaluateBudgetCheck({ budget: { tool_calls: 39 } }, trace({ gateway: within })).reason).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(evaluateBudgetCheck({ budget: { minutes: 11 } }, trace({ gateway: within })).reason).toBe(
      "BUDGET_EXCEEDED",
    );
  });

  it("fails with ATTEMPTS_EXHAUSTED past the stop attempts the check allows", () => {
    const tries = (n: number) => trace({ gateway: gateway({ usage: usage({ stopAttempts: n }) }) });
    expect(evaluateBudgetCheck({ budget: {} }, tries(3)).ok).toBe(true);
    expect(evaluateBudgetCheck({ budget: {} }, tries(4)).reason).toBe("ATTEMPTS_EXHAUSTED");
    expect(evaluateBudgetCheck({ budget: { stop_attempts: 1 } }, tries(2)).reason).toBe("ATTEMPTS_EXHAUSTED");
  });

  it("reports an exceeded limit before exhausted attempts", () => {
    const both = trace({ gateway: gateway({ usage: usage({ minutes: 9, stopAttempts: 9 }) }) });
    expect(evaluateBudgetCheck({ budget: { minutes: 1 } }, both).reason).toBe("BUDGET_EXCEEDED");
  });

  it("cannot decide a cost limit when the gateway reported no cost", () => {
    const noCost = trace({ gateway: gateway({ usage: usage({ usd: null }) }) });
    expect(evaluateBudgetCheck({ budget: { usd: 5 } }, noCost)).toMatchObject({
      ok: false,
      error: true,
      reason: "HARNESS_ERROR",
    });
    expect(evaluateBudgetCheck({ budget: { minutes: 5 } }, noCost).ok).toBe(true);
  });
});

describe("human check", () => {
  const check = { human: "mac" };
  const at = "2026-09-29T12:00:00Z";

  it("passes when the named person signed", () => {
    expect(evaluateHumanCheck(check, { by: "mac", at }).ok).toBe(true);
  });

  it("stays pending with no signature or someone else's", () => {
    expect(evaluateHumanCheck(check, undefined)).toMatchObject({ ok: false, reason: "HUMAN_PENDING" });
    const other = evaluateHumanCheck(check, { by: "someone-else", at });
    expect(other).toMatchObject({ ok: false, reason: "HUMAN_PENDING" });
    expect(other.error).toBeUndefined();
  });
});

describe("evaluateCheck", () => {
  const t = trace({
    runs: { "pnpm test": run() },
    files: { "a.ts": { sha256: FILE } },
    diff: { base: "abc", files: ["a.ts"] },
  });

  it("runs the evaluator for each kind", () => {
    expect(evaluateCheck({ run: "pnpm test" }, t).ok).toBe(true);
    expect(evaluateCheck({ file: { path: "a.ts" } }, t).ok).toBe(true);
    expect(evaluateCheck({ diff: { allow: ["*.ts"] } }, t).ok).toBe(true);
    expect(evaluateCheck({ tools: { deny: ["WebFetch"] } }, t).ok).toBe(true);
    expect(evaluateCheck({ budget: { minutes: 1 } }, t).ok).toBe(true);
    expect(evaluateCheck({ human: "mac" }, t, { by: "mac", at: "2026-09-29T12:00:00Z" }).ok).toBe(true);
    expect(evaluateCheck({ human: "mac" }, t).reason).toBe("HUMAN_PENDING");
  });
});
