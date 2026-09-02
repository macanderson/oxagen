import { describe, it, expect } from "vitest";
import {
  clipStr,
  extractJsonObject,
  shQuote,
  parseVitestJson,
  siblingTestCandidates,
  importGrepPattern,
  testFilesFromGrepHits,
  parseTscErrors,
  parseNumstat,
  parseDiffU0,
  combineDiff,
  symbolFromHunkContext,
  parsePorcelainV2,
  MAX_TEST_FAILURES,
} from "./parse";

describe("clipStr", () => {
  it("returns the input unchanged when within the cap", () => {
    expect(clipStr("hello", 10)).toBe("hello");
  });
  it("clips and marks the number of dropped chars", () => {
    expect(clipStr("abcdefghij", 4)).toBe("abcd… [6 chars truncated]");
  });
});

describe("shQuote", () => {
  it("wraps in single quotes and escapes embedded quotes", () => {
    expect(shQuote("a b")).toBe("'a b'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("extractJsonObject", () => {
  it("parses a clean JSON object", () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });
  it("extracts the object when preceded/followed by log noise", () => {
    expect(extractJsonObject('some log\n{"a":2}\ntrailing')).toEqual({ a: 2 });
  });
  it("ignores braces inside strings", () => {
    expect(extractJsonObject('{"k":"a}b"}')).toEqual({ k: "a}b" });
  });
  it("returns null when there is no object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("parseVitestJson", () => {
  const passing = JSON.stringify({
    numPassedTests: 3,
    numFailedTests: 0,
    numPendingTests: 1,
    testResults: [
      {
        name: "/repo/a.test.ts",
        startTime: 1000,
        endTime: 1200,
        assertionResults: [],
      },
    ],
  });
  const failing = JSON.stringify({
    numPassedTests: 1,
    numFailedTests: 1,
    testResults: [
      {
        name: "/repo/a.test.ts",
        assertionResults: [
          {
            fullName: "adds numbers",
            status: "failed",
            failureMessages: [
              "AssertionError: expected 1 to be 2\n at /repo/a.test.ts:12:5",
            ],
            location: { line: 12, column: 5 },
          },
        ],
      },
    ],
  });

  it("summarizes a passing run with wall-clock duration", () => {
    const r = parseVitestJson(passing);
    expect(r.passed).toBe(3);
    expect(r.failed).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.durationMs).toBe(200);
    expect(r.failures).toEqual([]);
    expect(r.parseError).toBeUndefined();
  });
  it("extracts a failing assertion with file:line and a cleaned reason", () => {
    const r = parseVitestJson(failing);
    expect(r.failed).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({
      test: "adds numbers",
      file: "/repo/a.test.ts",
      line: 12,
    });
    expect(r.failures[0]?.reason).toContain("expected 1 to be 2");
  });
  it("flags a parse error on unparseable input", () => {
    const r = parseVitestJson("not json");
    expect(r.parseError).toBe(true);
    expect(r.passed).toBe(0);
  });
  it("honors a lowered maxFailures cap and sets the truncation flag", () => {
    const many = JSON.stringify({
      numFailedTests: 3,
      testResults: [
        {
          name: "/repo/a.test.ts",
          assertionResults: [1, 2, 3].map((n) => ({
            fullName: `t${n}`,
            status: "failed",
            failureMessages: [`boom ${n}`],
          })),
        },
      ],
    });
    const r = parseVitestJson(many, 2);
    expect(r.failures).toHaveLength(2);
    expect(r.truncatedFailures).toBe(true);
  });
  it("defaults the cap to MAX_TEST_FAILURES", () => {
    expect(MAX_TEST_FAILURES).toBe(20);
  });
});

describe("test-file selection helpers", () => {
  it("siblingTestCandidates enumerates sibling and __tests__ paths", () => {
    const cands = siblingTestCandidates("src/foo.ts");
    expect(cands).toContain("src/foo.test.ts");
    expect(cands).toContain("src/__tests__/foo.test.ts");
    expect(cands).toContain("src/foo.spec.tsx");
  });
  it("siblingTestCandidates returns [] for a file that is itself a test", () => {
    expect(siblingTestCandidates("src/foo.test.ts")).toEqual([]);
  });
  it("importGrepPattern matches a path-boundary import of the base, not a substring", () => {
    const pat = importGrepPattern("src/sidebar.ts");
    expect(pat).not.toBeNull();
    const re = new RegExp(pat!);
    expect(re.test('import x from "./sidebar"')).toBe(true);
    expect(re.test('import x from "./sidebar.js"')).toBe(true);
    expect(re.test('import x from "./navsidebar"')).toBe(false);
  });
  it("testFilesFromGrepHits keeps only test-shaped paths, deduped and capped", () => {
    const hits = [
      "src/a.test.ts:3: import",
      "src/a.test.ts:9: import",
      "src/a.ts:1: import",
      "src/b.spec.ts:2: import",
    ];
    expect(testFilesFromGrepHits(hits, 10)).toEqual([
      "src/a.test.ts",
      "src/b.spec.ts",
    ]);
    expect(testFilesFromGrepHits(hits, 1)).toEqual(["src/a.test.ts"]);
  });
});

describe("parseTscErrors", () => {
  const out = [
    "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.",
    "src/a.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.", // dup
    "src/b.ts(3,1): error TS2304: Cannot find name 'foo'.",
    "some unrelated line",
  ].join("\n");
  it("parses, dedupes, and groups by file", () => {
    const r = parseTscErrors(out);
    expect(r.errorCount).toBe(2); // dup collapsed
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({
      file: "src/a.ts",
      line: 10,
      code: "TS2322",
    });
    expect(r.truncated).toBe(false);
  });
  it("honors a lowered maxErrors cap and flags truncation", () => {
    const r = parseTscErrors(out, 1);
    expect(r.errorCount).toBe(2);
    expect(r.errors).toHaveLength(1);
    expect(r.truncated).toBe(true);
  });
});

describe("git diff parsing", () => {
  it("parseNumstat reads additions/deletions and normalizes rename braces", () => {
    const m = parseNumstat(
      "5\t2\tsrc/a.ts\n-\t-\tbin.png\n3\t0\tsrc/{old => new}/c.ts",
    );
    expect(m.get("src/a.ts")).toEqual({ additions: 5, deletions: 2 });
    expect(m.get("bin.png")).toEqual({ additions: 0, deletions: 0 });
    expect(m.get("src/new/c.ts")).toEqual({ additions: 3, deletions: 0 });
  });
  it("symbolFromHunkContext pulls a declaration name and skips control keywords", () => {
    expect(symbolFromHunkContext("export function doThing(a: number) {")).toBe(
      "doThing",
    );
    expect(symbolFromHunkContext("class Widget {")).toBe("Widget");
    expect(symbolFromHunkContext("  if (x) {")).toBeNull();
  });
  it("parseDiffU0 derives change type and enclosing symbols", () => {
    const u0 = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,0 +11,2 @@ export function doThing() {",
      "+  const x = 1;",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,1 @@ class Fresh {",
      "+content",
    ].join("\n");
    const m = parseDiffU0(u0);
    expect(m.get("src/a.ts")).toEqual({
      changeType: "modified",
      symbols: ["doThing"],
    });
    expect(m.get("src/new.ts")).toEqual({
      changeType: "added",
      symbols: ["Fresh"],
    });
  });
  it("combineDiff merges stats + meta, sorts most-changed first, honors maxFiles", () => {
    const numstat = "5\t2\tsrc/a.ts\n1\t0\tsrc/b.ts";
    const u0 = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,0 +1,5 @@ function big() {",
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -1,0 +1,1 @@ function small() {",
    ].join("\n");
    const full = combineDiff(numstat, u0);
    expect(full.totals).toEqual({ files: 2, additions: 6, deletions: 2 });
    expect(full.files[0]?.path).toBe("src/a.ts"); // most changed first
    expect(full.files[0]?.symbols).toEqual(["big"]);
    const capped = combineDiff(numstat, u0, 1);
    expect(capped.files).toHaveLength(1);
    expect(capped.truncated).toBe(true);
  });
});

describe("parsePorcelainV2", () => {
  it("parses branch, upstream, ahead/behind, and dirty count", () => {
    const out = [
      "# branch.oid abc123",
      "# branch.head feat/x",
      "# branch.upstream origin/feat/x",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/a.ts",
      "? untracked.ts",
      "! ignored.ts",
    ].join("\n");
    const h = parsePorcelainV2(out);
    expect(h).toEqual({
      branch: "feat/x",
      upstream: "origin/feat/x",
      ahead: 2,
      behind: 1,
      dirtyFiles: 2, // changed + untracked; ignored excluded
    });
  });
  it("reports a null branch when detached", () => {
    expect(parsePorcelainV2("# branch.head (detached)").branch).toBeNull();
  });
});
