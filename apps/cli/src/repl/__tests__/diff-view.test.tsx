import { describe, it, expect } from "vitest";
import { render } from "ink-testing-library";
import {
  DiffView,
  parseDiffLines,
  languageForPath,
  numberDiffLines,
} from "../diff-view.js";
import { DARK_DIFF_THEME, LIGHT_DIFF_THEME } from "../../tui/terminal-theme.js";

const SAMPLE_DIFF = [
  "diff --git a/src/greet.ts b/src/greet.ts",
  "index 1111111..2222222 100644",
  "--- a/src/greet.ts",
  "+++ b/src/greet.ts",
  "@@ -1,3 +1,3 @@",
  " function greet(name: string) {",
  '-  return "hi " + name;',
  "+  return `hello ${name}`;",
  " }",
].join("\n");

describe("parseDiffLines", () => {
  it("classifies file-header lines as meta and preserves the full text as code", () => {
    const lines = parseDiffLines(SAMPLE_DIFF);
    expect(lines[0]).toEqual({
      kind: "meta",
      text: "diff --git a/src/greet.ts b/src/greet.ts",
      code: "diff --git a/src/greet.ts b/src/greet.ts",
    });
    expect(lines[1]?.kind).toBe("meta");
    expect(lines[2]?.kind).toBe("meta");
    expect(lines[3]?.kind).toBe("meta");
  });

  it("classifies the hunk header", () => {
    const lines = parseDiffLines(SAMPLE_DIFF);
    const hunk = lines.find((l) => l.text.startsWith("@@"));
    expect(hunk).toEqual({
      kind: "hunk",
      text: "@@ -1,3 +1,3 @@",
      code: "@@ -1,3 +1,3 @@",
    });
  });

  it("classifies added lines and strips the leading marker into `code`", () => {
    const lines = parseDiffLines(SAMPLE_DIFF);
    const added = lines.find((l) => l.kind === "add");
    expect(added).toEqual({
      kind: "add",
      text: "+  return `hello ${name}`;",
      code: "  return `hello ${name}`;",
    });
  });

  it("classifies removed lines and strips the leading marker into `code`", () => {
    const lines = parseDiffLines(SAMPLE_DIFF);
    const removed = lines.find((l) => l.kind === "del");
    expect(removed).toEqual({
      kind: "del",
      text: '-  return "hi " + name;',
      code: '  return "hi " + name;',
    });
  });

  it("classifies unchanged lines as context and strips the leading space into `code`", () => {
    const lines = parseDiffLines(SAMPLE_DIFF);
    const context = lines.filter((l) => l.kind === "context");
    expect(context).toEqual([
      {
        kind: "context",
        text: " function greet(name: string) {",
        code: "function greet(name: string) {",
      },
      { kind: "context", text: " }", code: "}" },
    ]);
  });

  it("drops the phantom trailing blank line from a diff ending in a newline", () => {
    const lines = parseDiffLines(SAMPLE_DIFF + "\n");
    expect(lines).toHaveLength(parseDiffLines(SAMPLE_DIFF).length);
  });

  it("treats an unprefixed blank line (malformed/edge input) as context rather than throwing", () => {
    // Real unified diffs prefix even blank context lines with a space, but the
    // parser must stay defensive about malformed input instead of misclassifying
    // or throwing.
    const withBlank = "@@ -1,2 +1,2 @@\n\n+added after a blank line";
    const lines = parseDiffLines(withBlank);
    expect(lines[1]).toEqual({ kind: "context", text: "", code: "" });
    expect(lines[2]).toEqual({
      kind: "add",
      text: "+added after a blank line",
      code: "added after a blank line",
    });
  });

  it("treats a space-only context line (blank source line) as context with empty code", () => {
    const withBlankContext = SAMPLE_DIFF.replace(" }", " }\n \n+// trailing");
    const lines = parseDiffLines(withBlankContext);
    const blankContext = lines.find((l) => l.text === " ");
    expect(blankContext).toEqual({ kind: "context", text: " ", code: "" });
  });
});

describe("languageForPath", () => {
  it.each([
    ["src/index.ts", "typescript"],
    ["src/App.tsx", "typescript"],
    ["scripts/build.js", "javascript"],
    ["tool.py", "python"],
    ["main.go", "go"],
    ["lib.rs", "rust"],
    ["data.json", "json"],
    ["README.md", "markdown"],
    ["deploy.sh", "bash"],
  ])("maps %s to %s", (path, expected) => {
    expect(languageForPath(path)).toBe(expected);
  });

  it.each([["Makefile"], ["noext"], ["archive.tar.gz.bin"]])(
    "returns undefined for an unknown extension (%s)",
    (path) => {
      expect(languageForPath(path)).toBeUndefined();
    },
  );
});

describe("numberDiffLines", () => {
  it("assigns old/new numbers from the hunk header, advancing per line kind", () => {
    const numbered = numberDiffLines(parseDiffLines(SAMPLE_DIFF));
    // Meta + hunk lines carry no numbers.
    expect(numbered[0]).toMatchObject({ kind: "meta" });
    expect(numbered[0]!.oldLine).toBeUndefined();
    const hunk = numbered.find((l) => l.kind === "hunk")!;
    expect(hunk.oldLine).toBeUndefined();
    expect(hunk.newLine).toBeUndefined();
    // `@@ -1,3 +1,3 @@` → first context line is old 1 / new 1.
    const firstContext = numbered.find((l) => l.kind === "context")!;
    expect(firstContext).toMatchObject({ oldLine: 1, newLine: 1 });
    // The removed line has only an old number; the added line only a new number.
    const del = numbered.find((l) => l.kind === "del")!;
    expect(del.oldLine).toBe(2);
    expect(del.newLine).toBeUndefined();
    const add = numbered.find((l) => l.kind === "add")!;
    expect(add.newLine).toBe(2);
    expect(add.oldLine).toBeUndefined();
    // The trailing context line advanced past the change: old 3 / new 3.
    const contexts = numbered.filter((l) => l.kind === "context");
    expect(contexts[contexts.length - 1]).toMatchObject({
      oldLine: 3,
      newLine: 3,
    });
  });

  it("resets counters across multiple hunks and handles the omitted-count form", () => {
    const twoHunks = [
      "@@ -5 +5 @@", // omitted-count form: single line at 5/5
      " context a",
      "@@ -20,2 +21,2 @@",
      "-removed at 20",
      "+added at 21",
      " context after",
    ].join("\n");
    const numbered = numberDiffLines(parseDiffLines(twoHunks));
    // First hunk (omitted counts) starts both counters at 5.
    expect(numbered.find((l) => l.kind === "context")).toMatchObject({
      oldLine: 5,
      newLine: 5,
    });
    // Second hunk reset to old 20 / new 21.
    const del = numbered.find((l) => l.kind === "del")!;
    expect(del.oldLine).toBe(20);
    const add = numbered.find((l) => l.kind === "add")!;
    expect(add.newLine).toBe(21);
    const trailing = numbered.filter((l) => l.kind === "context");
    expect(trailing[trailing.length - 1]).toMatchObject({
      oldLine: 21,
      newLine: 22,
    });
  });
});

describe("DiffView — showLineNumbers", () => {
  it("renders a right-aligned old/new gutter with a divider, aligned across line kinds", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={DARK_DIFF_THEME} showLineNumbers />,
    );
    const frame = lastFrame() ?? "";
    // Gutter divider present, and the code content still renders.
    expect(frame).toContain("│");
    expect(frame).toContain("hello");
    // Every rendered row shares the same divider column (stable gutter width).
    const rows = frame.split("\n").filter((r) => r.includes("│"));
    expect(rows.length).toBeGreaterThan(0);
    const dividerCols = new Set(rows.map((r) => r.indexOf("│")));
    expect(dividerCols.size).toBe(1);
  });

  it("omits the gutter by default (existing usages unchanged)", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={DARK_DIFF_THEME} />,
    );
    expect(lastFrame() ?? "").not.toContain("│");
  });
});

describe("DiffView", () => {
  it("renders without throwing and shows added/removed code content", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={DARK_DIFF_THEME} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("hello");
    expect(frame).toContain("hi");
    // Individual tokens rather than a contiguous phrase: cli-highlight wraps
    // each token in its own ANSI escape, so "function" and "greet" aren't
    // adjacent substrings in the raw output even though they render adjacent
    // on screen.
    expect(frame).toContain("function");
    expect(frame).toContain("greet");
    expect(frame).toContain("@@ -1,3 +1,3 @@");
  });

  it("renders with the light theme without throwing", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={LIGHT_DIFF_THEME} />,
    );
    expect(lastFrame() ?? "").toContain("hello");
  });

  it("infers the language from the +++ b/<path> header when none is supplied", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={DARK_DIFF_THEME} />,
    );
    // Just asserting it renders cleanly with inference on — token colors aren't
    // asserted since they're an implementation detail of cli-highlight.
    expect(lastFrame()).toBeTruthy();
  });

  it("never throws on an unrecognized/unsupported language", () => {
    expect(() =>
      render(
        <DiffView
          diff={SAMPLE_DIFF}
          theme={DARK_DIFF_THEME}
          language="not-a-real-lang"
        />,
      ),
    ).not.toThrow();
  });

  it("truncates past maxLines and shows the 'more lines' note", () => {
    const bigDiff = [
      "diff --git a/big.txt b/big.txt",
      "--- a/big.txt",
      "+++ b/big.txt",
      "@@ -1,5 +1,5 @@",
      ...Array.from({ length: 20 }, (_, i) => `+line ${i}`),
    ].join("\n");
    const { lastFrame } = render(
      <DiffView diff={bigDiff} theme={DARK_DIFF_THEME} maxLines={5} />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("more lines — scroll or /replay to see all");
    expect(frame).not.toContain("line 19");
  });

  it("does not truncate when the diff is within maxLines", () => {
    const { lastFrame } = render(
      <DiffView diff={SAMPLE_DIFF} theme={DARK_DIFF_THEME} maxLines={500} />,
    );
    expect(lastFrame() ?? "").not.toContain("more lines");
  });
});
