/**
 * Mutation verifier — pure core.
 *
 * Covers the deterministic half of the gate: unified-diff parsing (including
 * every "refuse to guess" unsupported shape), test/source partitioning,
 * reverse reconstruction of pre-fix contents, witness command planning, the
 * witness-claim guard, outcome math, the verdict override, the env resolver,
 * and mutant generation. No I/O anywhere — these are the functions the 90%
 * coverage gate leans on.
 */
import { describe, it, expect } from "vitest";
import {
  parseUnifiedDiff,
  partitionByTestPath,
  reconstructOriginal,
  planWitnessCommands,
  hasWitnessClaim,
  witnessOutcome,
  classifyWitnessRun,
  describeMutationScore,
  applyGateToVerdict,
  resolveMutationVerifyEnabled,
  generateMutants,
  type DiffFile,
  type MutationGateResult,
  type WitnessRun,
} from "./mutation";

// ── Fixtures ───────────────────────────────────────────────────────────────────

const MODIFIED_DIFF = [
  "diff --git a/src/calc.ts b/src/calc.ts",
  "index 1111111..2222222 100644",
  "--- a/src/calc.ts",
  "+++ b/src/calc.ts",
  "@@ -1,3 +1,3 @@",
  " export function add(a: number, b: number): number {",
  "-  return a - b;",
  "+  return a + b;",
  " }",
].join("\n");

const FIXED_CONTENT =
  "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const ORIGINAL_CONTENT =
  "export function add(a: number, b: number): number {\n  return a - b;\n}\n";

const CREATED_DIFF = [
  "diff --git a/src/calc.test.ts b/src/calc.test.ts",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/calc.test.ts",
  "@@ -0,0 +1,2 @@",
  "+import { add } from './calc';",
  "+test('adds', () => expect(add(1, 2)).toBe(3));",
].join("\n");

const DELETED_DIFF = [
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-line one",
  "-line two",
].join("\n");

// ── parseUnifiedDiff ───────────────────────────────────────────────────────────

describe("parseUnifiedDiff", () => {
  it("parses a modified-file segment with hunks", () => {
    const files = parseUnifiedDiff(MODIFIED_DIFF);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f.path).toBe("src/calc.ts");
    expect(f.kind).toBe("modified");
    expect(f.unsupported).toBeUndefined();
    expect(f.hunks).toHaveLength(1);
    expect(f.hunks[0]).toMatchObject({
      oldStart: 1,
      oldLines: 3,
      newStart: 1,
      newLines: 3,
    });
    expect(f.hunks[0]!.lines).toHaveLength(4);
  });

  it("classifies created and deleted files", () => {
    const created = parseUnifiedDiff(CREATED_DIFF)[0]!;
    expect(created.kind).toBe("created");
    expect(created.path).toBe("src/calc.test.ts");

    const deleted = parseUnifiedDiff(DELETED_DIFF)[0]!;
    expect(deleted.kind).toBe("deleted");
    expect(deleted.path).toBe("src/old.ts");
  });

  it("parses multiple segments in one diff", () => {
    const files = parseUnifiedDiff(MODIFIED_DIFF + "\n" + CREATED_DIFF);
    expect(files.map((f) => f.path)).toEqual([
      "src/calc.ts",
      "src/calc.test.ts",
    ]);
  });

  it("returns [] for an empty or whitespace diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("  \n ")).toEqual([]);
  });

  it("marks renames unsupported", () => {
    const diff = [
      "diff --git a/a.ts b/b.ts",
      "similarity index 100%",
      "rename from a.ts",
      "rename to b.ts",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]!.unsupported).toBe("rename");
  });

  it("marks binary files unsupported", () => {
    const diff = [
      "diff --git a/logo.png b/logo.png",
      "index 1111111..2222222 100644",
      "Binary files a/logo.png and b/logo.png differ",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]!.unsupported).toBe("binary file");
  });

  it("marks quoted (special-character) paths unsupported", () => {
    const diff = [
      'diff --git "a/we ird.ts" "b/we ird.ts"',
      '--- "a/we ird.ts"',
      '+++ "b/we ird.ts"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]!.unsupported).toBe("quoted path");
  });

  it("marks missing-trailing-newline segments unsupported", () => {
    const diff = [
      "diff --git a/x.ts b/x.ts",
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "\\ No newline at end of file",
    ].join("\n");
    expect(parseUnifiedDiff(diff)[0]!.unsupported).toBe(
      "missing trailing newline",
    );
  });

  it("marks hunkless segments unsupported (MemoryWorkspace-style diffs)", () => {
    const files = parseUnifiedDiff("--- a/x.ts\n+++ b/x.ts");
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe("x.ts");
    expect(files[0]!.unsupported).toBe("segment has no hunks");
  });

  it("accepts bare ---/+++ segments with hunks (no diff --git header)", () => {
    const diff = [
      "--- a/x.ts",
      "+++ b/x.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "--- a/y.ts",
      "+++ b/y.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["x.ts", "y.ts"]);
    expect(files.every((f) => f.unsupported === undefined)).toBe(true);
  });
});

// ── partitionByTestPath ────────────────────────────────────────────────────────

describe("partitionByTestPath", () => {
  it("splits test files from source files", () => {
    const files = parseUnifiedDiff(MODIFIED_DIFF + "\n" + CREATED_DIFF);
    const { testFiles, sourceFiles } = partitionByTestPath(files);
    expect(testFiles.map((f) => f.path)).toEqual(["src/calc.test.ts"]);
    expect(sourceFiles.map((f) => f.path)).toEqual(["src/calc.ts"]);
  });
});

// ── reconstructOriginal ────────────────────────────────────────────────────────

describe("reconstructOriginal", () => {
  it("reverse-applies a single hunk to recover the pre-fix content", () => {
    const file = parseUnifiedDiff(MODIFIED_DIFF)[0]!;
    expect(reconstructOriginal(file, FIXED_CONTENT)).toBe(ORIGINAL_CONTENT);
  });

  it("reverse-applies multiple hunks bottom-up", () => {
    const diff = [
      "diff --git a/m.ts b/m.ts",
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -1,2 +1,2 @@",
      "-one",
      "+ONE",
      " two",
      "@@ -4,2 +4,2 @@",
      " four",
      "-five",
      "+FIVE",
    ].join("\n");
    const file = parseUnifiedDiff(diff)[0]!;
    const current = "ONE\ntwo\nthree\nfour\nFIVE\n";
    expect(reconstructOriginal(file, current)).toBe(
      "one\ntwo\nthree\nfour\nfive\n",
    );
  });

  it("returns undefined when the current content no longer matches the diff", () => {
    const file = parseUnifiedDiff(MODIFIED_DIFF)[0]!;
    expect(
      reconstructOriginal(file, "something else entirely\n"),
    ).toBeUndefined();
  });

  it("returns undefined when a hunk points past the end of the file", () => {
    const diff = [
      "--- a/m.ts",
      "+++ b/m.ts",
      "@@ -50,2 +50,2 @@",
      "-x",
      "+y",
      " z",
    ].join("\n");
    const file = parseUnifiedDiff(diff)[0]!;
    expect(reconstructOriginal(file, "y\nz\n")).toBeUndefined();
  });

  it("returns null (delete me) for created files", () => {
    const file = parseUnifiedDiff(CREATED_DIFF)[0]!;
    expect(reconstructOriginal(file, "whatever\n")).toBeNull();
  });

  it("rebuilds deleted files from the old side", () => {
    const file = parseUnifiedDiff(DELETED_DIFF)[0]!;
    expect(reconstructOriginal(file, null)).toBe("line one\nline two\n");
  });

  it("returns undefined for a deleted file that still exists", () => {
    const file = parseUnifiedDiff(DELETED_DIFF)[0]!;
    expect(reconstructOriginal(file, "still here\n")).toBeUndefined();
  });

  it("returns undefined for unsupported segments and vanished files", () => {
    const unsupported: DiffFile = {
      path: "x.ts",
      kind: "modified",
      hunks: [],
      unsupported: "rename",
    };
    expect(reconstructOriginal(unsupported, "x\n")).toBeUndefined();
    const file = parseUnifiedDiff(MODIFIED_DIFF)[0]!;
    expect(reconstructOriginal(file, null)).toBeUndefined();
  });
});

// ── witness planning ───────────────────────────────────────────────────────────

describe("planWitnessCommands", () => {
  it("keeps only passing commands, flip first, capped", () => {
    const outcomes = new Map<string, number>([
      ["pnpm vitest run a.test.ts", 0],
      ["pnpm vitest run b.test.ts", 1],
      ["pnpm vitest run c.test.ts", 0],
      ["pnpm vitest run d.test.ts", 0],
    ]);
    expect(
      planWitnessCommands(
        { lastOutcomes: outcomes, flippedBy: "pnpm vitest run c.test.ts" },
        2,
      ),
    ).toEqual(["pnpm vitest run c.test.ts", "pnpm vitest run a.test.ts"]);
  });

  it("ignores a flip whose latest outcome is failing", () => {
    const outcomes = new Map<string, number>([
      ["pnpm vitest run a.test.ts", 1],
    ]);
    expect(
      planWitnessCommands(
        { lastOutcomes: outcomes, flippedBy: "pnpm vitest run a.test.ts" },
        3,
      ),
    ).toEqual([]);
  });
});

describe("hasWitnessClaim", () => {
  const noEvidence = {
    lastOutcomes: new Map<string, number>(),
    flippedBy: null,
  };
  it("claims via a fail→pass flip or changed test files", () => {
    expect(hasWitnessClaim({ ...noEvidence, flippedBy: "cmd" }, 0)).toBe(true);
    expect(hasWitnessClaim(noEvidence, 1)).toBe(true);
    expect(hasWitnessClaim(noEvidence, 0)).toBe(false);
  });
});

describe("witnessOutcome", () => {
  it("is witnessed when a run actually failed", () => {
    expect(
      witnessOutcome([{ command: "c", exitCode: 1, timedOut: false }]).status,
    ).toBe("witnessed");
  });

  it("is vacuous when every run passes", () => {
    expect(
      witnessOutcome([
        { command: "a", exitCode: 0, timedOut: false },
        { command: "b", exitCode: 0, timedOut: false },
      ]).status,
    ).toBe("vacuous");
  });

  // This assertion is inverted from what it was. It used to require a
  // timed-out run to read as "witnessed", which is the defect in #1359: the
  // run did not finish, so it established nothing, and a wrong `witnessed` is
  // silent because only a `vacuous` result is folded back into the revise loop.
  it("does not turn a timeout into a proof", () => {
    const verdict = witnessOutcome([
      { command: "c", exitCode: null, timedOut: true, isClaim: true },
    ]);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("did not finish");
    expect(verdict.reason).toContain("c");
  });

  it("does not turn a failure-to-start into a proof (#1362)", () => {
    // The revert deletes the module the new test imports, so the suite exits
    // non-zero at collection. The tests never ran.
    const verdict = witnessOutcome([
      {
        command: "pytest -x",
        exitCode: 2,
        timedOut: false,
        output: "ModuleNotFoundError: No module named 'src.thing'",
        isClaim: true,
      },
    ]);
    expect(verdict.status).toBe("skipped");
    expect(verdict.reason).toContain("before running any test");
  });

  it.each([
    ["ModuleNotFoundError: No module named 'x'", "python import"],
    ["Error: Cannot find module './thing'", "node resolution"],
    ["ERR_MODULE_NOT_FOUND", "node esm"],
    ['Failed to resolve import "./thing"', "a bundler"],
    ["ERROR collecting tests/test_thing.py", "a collection error"],
    ["error TS2307: Cannot find module './thing'", "typescript"],
    ["No test files found", "an empty run"],
  ])("treats %s as not-run (%s)", (output) => {
    expect(
      classifyWitnessRun({
        command: "c",
        exitCode: 1,
        timedOut: false,
        output,
      }),
    ).toBe("did-not-run");
  });

  it("still calls an ordinary assertion failure a real failure", () => {
    expect(
      classifyWitnessRun({
        command: "pytest -x",
        exitCode: 1,
        timedOut: false,
        output: "FAILED tests/test_thing.py::test_it - assert 1 == 2",
      }),
    ).toBe("tests-failed");
  });

  // The markers are matched against combined stdout+stderr, so a suite whose
  // own output quotes one is read as a suite that never started. Pinned rather
  // than left to be rediscovered: this withholds a proof instead of granting
  // one, which is the direction it is safe to be wrong in, and narrowing it
  // needs a per-runner "tests ran" signal no two runners agree on.
  it("errs towards did-not-run when a real failure quotes a marker", () => {
    expect(
      classifyWitnessRun({
        command: "pytest -x",
        exitCode: 1,
        timedOut: false,
        output:
          "FAILED tests/test_parser.py::test_rejects - DID NOT RAISE SyntaxError",
      }),
    ).toBe("did-not-run");
  });

  // The flip is the agent's own claimed witness. It used to carry no more
  // weight than any other command, so an unrelated failure could certify a
  // turn whose actual claim passed without the fix (#1359).
  it("lets the claim decide, so corroboration cannot rescue a vacuous turn", () => {
    const verdict = witnessOutcome([
      { command: "flip", exitCode: 0, timedOut: false, isClaim: true },
      { command: "unrelated", exitCode: 1, timedOut: false },
    ]);
    expect(verdict.status).toBe("vacuous");
  });

  it("lets the claim decide in the other direction too", () => {
    const verdict = witnessOutcome([
      { command: "flip", exitCode: 1, timedOut: false, isClaim: true },
      { command: "unrelated", exitCode: 0, timedOut: false },
    ]);
    expect(verdict.status).toBe("witnessed");
  });

  it("falls back to any real failure when there is no flip to judge", () => {
    expect(
      witnessOutcome([
        { command: "a", exitCode: 0, timedOut: false },
        { command: "b", exitCode: 1, timedOut: false },
      ]).status,
    ).toBe("witnessed");
  });

  // The two shapes Sourcery's #1359 assessment read as gaps: a timed-out run
  // sitting beside a run that really failed, with and without a claim. They
  // are not gaps, and these pin why — the timeout is load-bearing for
  // nothing. Each case asserts the verdict three times: with the timeout,
  // without it (the same answer, so the timeout added nothing), and with the
  // timeout alone (`skipped`, so it is not proof on its own). A change that
  // made a timeout count as evidence would fail the third assertion; one that
  // made it veto a genuine failing witness would fail the first.
  it("does not let a corroborating timeout weigh on a claim that really failed (#1359)", () => {
    const claim: WitnessRun = {
      command: "flip",
      exitCode: 1,
      timedOut: false,
      isClaim: true,
    };
    const stalled: WitnessRun = {
      command: "corroborating",
      exitCode: null,
      timedOut: true,
    };

    expect(witnessOutcome([claim, stalled]).status).toBe("witnessed");
    expect(witnessOutcome([claim]).status).toBe("witnessed");
    expect(witnessOutcome([stalled]).status).toBe("skipped");
  });

  it("does not let a timeout weigh on a real failure when there is no claim (#1359)", () => {
    const stalled: WitnessRun = {
      command: "stalled",
      exitCode: null,
      timedOut: true,
    };
    const failed: WitnessRun = {
      command: "failing",
      exitCode: 1,
      timedOut: false,
    };

    expect(witnessOutcome([stalled, failed]).status).toBe("witnessed");
    expect(witnessOutcome([failed]).status).toBe("witnessed");
    expect(witnessOutcome([stalled]).status).toBe("skipped");
  });

  it("skips rather than concluding when no run produced a usable result", () => {
    const verdict = witnessOutcome([
      { command: "a", exitCode: 0, timedOut: false },
      { command: "b", exitCode: null, timedOut: true },
    ]);
    expect(verdict.status).toBe("skipped");
  });

  it("skips on no runs at all", () => {
    expect(witnessOutcome([]).status).toBe("skipped");
  });
});

describe("describeMutationScore (#1351)", () => {
  it("never prints a percentage for a measurement that did not happen", () => {
    for (const state of [
      "not-applicable",
      "aborted",
      "workspace-error",
    ] as const) {
      const line = describeMutationScore({
        state,
        mutantsTried: 0,
        mutantsKilled: 0,
        killRate: null,
        survivors: [],
      });
      expect(line).toContain("not measured");
      expect(line).not.toMatch(/\d+%/);
    }
  });

  it("prints the rate when there is one", () => {
    expect(
      describeMutationScore({
        state: "measured",
        mutantsTried: 4,
        mutantsKilled: 3,
        killRate: 0.75,
        survivors: [],
      }),
    ).toContain("75%");
  });
});

// ── verdict override ───────────────────────────────────────────────────────────

function gateResult(status: MutationGateResult["status"]): MutationGateResult {
  return {
    status,
    reason: "r",
    runs: [
      { command: "pnpm vitest run a.test.ts", exitCode: 0, timedOut: false },
    ],
    revertedFiles: ["src/calc.ts"],
    testFiles: ["src/calc.test.ts"],
    durationMs: 5,
  };
}

describe("applyGateToVerdict", () => {
  const verdict = {
    complete: true,
    findings: [] as string[],
    remainingWork: [] as string[],
    reasoning: "looks done",
  };

  it("overrides a complete verdict on vacuous", () => {
    const out = applyGateToVerdict(verdict, gateResult("vacuous"));
    expect(out.complete).toBe(false);
    expect(out.findings[0]).toContain("Mutation gate");
    expect(out.remainingWork[0]).toContain("FAILS without the fix");
    expect(out.reasoning).toContain("[mutation gate]");
  });

  it("leaves witnessed and skipped verdicts untouched", () => {
    expect(applyGateToVerdict(verdict, gateResult("witnessed"))).toBe(verdict);
    expect(applyGateToVerdict(verdict, gateResult("skipped"))).toBe(verdict);
  });
});

describe("resolveMutationVerifyEnabled", () => {
  it("defaults ON, honors the env kill switch, and lets the option win", () => {
    expect(resolveMutationVerifyEnabled({})).toBe(true);
    expect(resolveMutationVerifyEnabled({ OXAGEN_MUTATION_VERIFY: "0" })).toBe(
      false,
    );
    expect(
      resolveMutationVerifyEnabled({ OXAGEN_MUTATION_VERIFY: "false" }),
    ).toBe(false);
    expect(resolveMutationVerifyEnabled({ OXAGEN_MUTATION_VERIFY: "1" })).toBe(
      true,
    );
    expect(
      resolveMutationVerifyEnabled({ OXAGEN_MUTATION_VERIFY: "0" }, true),
    ).toBe(true);
    expect(resolveMutationVerifyEnabled({}, false)).toBe(false);
  });
});

// ── generateMutants ────────────────────────────────────────────────────────────

describe("generateMutants", () => {
  const content = [
    "function eq(a: number, b: number): boolean {",
    "  if (a === b) {",
    "    return true;",
    "  }",
    "  return false;",
    "}",
    "",
  ].join("\n");
  const diff = [
    "diff --git a/src/eq.ts b/src/eq.ts",
    "--- a/src/eq.ts",
    "+++ b/src/eq.ts",
    "@@ -1,2 +1,6 @@",
    " function eq(a: number, b: number): boolean {",
    "+  if (a === b) {",
    "+    return true;",
    "+  }",
    "+  return false;",
    " }",
  ].join("\n");

  it("mutates only added lines, one mutant per line, deterministically", () => {
    const file = parseUnifiedDiff(diff)[0]!;
    const mutants = generateMutants(file, content, 10);
    expect(mutants.map((m) => m.description)).toEqual([
      "=== → !==",
      "true → false",
      "false → true",
    ]);
    expect(mutants[0]).toMatchObject({ path: "src/eq.ts", line: 2 });
    expect(mutants[0]!.mutatedContent).toContain("if (a !== b) {");
    // Everything else is untouched, trailing newline preserved.
    expect(mutants[0]!.mutatedContent.endsWith("}\n")).toBe(true);
  });

  it("caps the number of mutants", () => {
    const file = parseUnifiedDiff(diff)[0]!;
    expect(generateMutants(file, content, 1)).toHaveLength(1);
    expect(generateMutants(file, content, 0)).toHaveLength(0);
  });

  it("skips comments, imports, and lines that no longer match", () => {
    const d = [
      "--- a/src/x.ts",
      "+++ b/src/x.ts",
      "@@ -1,1 +1,3 @@",
      " const keep = 1;",
      "+// a === b comment",
      "+import { a } from './a';",
    ].join("\n");
    const file = parseUnifiedDiff(d)[0]!;
    const current =
      "const keep = 1;\n// a === b comment\nimport { a } from './a';\n";
    expect(generateMutants(file, current, 10)).toEqual([]);
    // Diverged content produces nothing rather than mis-targeted mutants.
    expect(generateMutants(file, "totally\ndifferent\nfile\n", 10)).toEqual([]);
  });

  it("returns [] for created/deleted/unsupported segments", () => {
    const created = parseUnifiedDiff(CREATED_DIFF)[0]!;
    expect(generateMutants(created, "x\n", 10)).toEqual([]);
    const deleted = parseUnifiedDiff(DELETED_DIFF)[0]!;
    expect(generateMutants(deleted, "x\n", 10)).toEqual([]);
  });

  it("exercises every remaining operator: !==, &&, ||, <=, >=, early return", () => {
    const opLines = [
      "if (a !== b) fail();",
      "if (a && b) go();",
      "if (a || b) go();",
      "if (a <= b) go();",
      "if (a >= b) go();",
      "return compute(a);",
    ];
    const current = [
      "function f(a, b) {",
      ...opLines.map((l) => "  " + l),
      "}",
      "",
    ].join("\n");
    const d = [
      "--- a/src/ops.ts",
      "+++ b/src/ops.ts",
      "@@ -1,2 +1,8 @@",
      " function f(a, b) {",
      ...opLines.map((l) => "+  " + l),
      " }",
    ].join("\n");
    const file = parseUnifiedDiff(d)[0]!;
    const mutants = generateMutants(file, current, 10);
    expect(mutants.map((m) => m.description)).toEqual([
      "!== → ===",
      "&& → ||",
      "|| → &&",
      "<= → <",
      ">= → >",
      "early return",
    ]);
    expect(mutants[0]!.mutatedContent).toContain("if (a === b) fail();");
    expect(mutants[1]!.mutatedContent).toContain("if (a || b) go();");
    expect(mutants[2]!.mutatedContent).toContain("if (a && b) go();");
    expect(mutants[3]!.mutatedContent).toContain("if (a < b) go();");
    expect(mutants[4]!.mutatedContent).toContain("if (a > b) go();");
    expect(mutants[5]!.mutatedContent).toContain("return; // compute(a);");
  });
});
