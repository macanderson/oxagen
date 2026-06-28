/**
 * Unified builder tests — proves the CLI code-graph builder now uses
 * @oxagen/code-graph (tree-sitter) instead of the old regex extractor.
 *
 * Strategy: mock @oxagen/code-graph at the module level to provide controlled
 * parseSourceFile() returns. This tests the BUILDER's logic (ParsedSymbol →
 * CodeNode mapping, edge creation, incremental persistence) independently of
 * the tree-sitter WASM loading — the WASM behavior is already covered by
 * packages/code-graph/src/__tests__/parser.test.ts.
 *
 * Key coverage:
 *  - arrow_function symbols (const f = () => {}) — old regex missed these
 *  - method symbols — old regex missed these
 *  - type, interface symbols — consistent with tree-sitter output
 *  - the builder maps ParsedSymbol → CodeNode correctly (range, signature, docstring)
 *  - contains edges from file node to each symbol
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParseResult } from "@oxagen/code-graph";

// ---------------------------------------------------------------------------
// Mock @oxagen/code-graph so the builder can be tested without real WASM
// ---------------------------------------------------------------------------
// vi.mock factories are hoisted to the top of the file by vitest's babel
// transform, BEFORE const/let declarations are evaluated. Use vi.hoisted()
// to ensure the mock function is available to the factory at hoist time.

const mockParseSourceFile = vi.hoisted(() =>
  vi.fn<(path: string, content: string) => Promise<ParseResult>>(),
);

vi.mock("@oxagen/code-graph", () => ({
  parseSourceFile: mockParseSourceFile,
}));

// ---------------------------------------------------------------------------
// Import the builder AFTER the mock is hoisted
// ---------------------------------------------------------------------------

import { fileGraphFromContent, listSourceFiles } from "../builder";

// ---------------------------------------------------------------------------
// Helper: build a typical ParseResult with various symbol kinds
// ---------------------------------------------------------------------------

function makeParseResult(
  symbols: Array<{
    name: string;
    kind: "function" | "class" | "method" | "interface" | "type" | "arrow_function" | "heading";
    startLine: number;
    endLine: number;
    signature?: string;
    docComment?: string;
  }>,
): ParseResult {
  return {
    language: "typescript",
    symbols: symbols.map((s) => ({
      name: s.name,
      kind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
      ...(s.signature ? { signature: s.signature } : {}),
      ...(s.docComment ? { docComment: s.docComment } : {}),
    })),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("builder — unified tree-sitter extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("extracts arrow_function symbols (which the old regex missed)", async () => {
    mockParseSourceFile.mockResolvedValueOnce(
      makeParseResult([
        { name: "fetchData",    kind: "arrow_function", startLine: 0, endLine: 1 },
        { name: "processItems", kind: "arrow_function", startLine: 2, endLine: 2 },
        { name: "namedFn",      kind: "function",       startLine: 4, endLine: 4 },
        { name: "MyService",    kind: "class",          startLine: 6, endLine: 8 },
        { name: "doWork",       kind: "method",         startLine: 7, endLine: 7 },
      ]),
    );

    const content = [
      "const fetchData = async () => { return fetch('/api'); };",
      "",
      "const processItems = (x: string[]) => x.map(String);",
      "",
      "export function namedFn() { return 42; }",
      "",
      "class MyService {",
      "  doWork() { return true; }",
      "}",
    ].join("\n");

    const fg = await fileGraphFromContent("src/service.ts", content, "/root");

    const symbolNodes = fg.nodes.filter((n) => n.kind !== "file");
    const kinds = symbolNodes.map((n) => n.kind);

    // Arrow functions — the key regression: old regex never captured these
    expect(kinds).toContain("arrow_function");
    const arrowSymbols = symbolNodes.filter((n) => n.kind === "arrow_function");
    expect(arrowSymbols.map((s) => s.name)).toContain("fetchData");
    expect(arrowSymbols.map((s) => s.name)).toContain("processItems");
    expect(arrowSymbols).toHaveLength(2);

    // Named function
    expect(kinds).toContain("function");
    expect(symbolNodes.find((n) => n.kind === "function")!.name).toBe("namedFn");

    // Class and method — old regex missed methods
    expect(kinds).toContain("class");
    expect(symbolNodes.find((n) => n.kind === "class")!.name).toBe("MyService");
    expect(kinds).toContain("method");
    expect(symbolNodes.find((n) => n.kind === "method")!.name).toBe("doWork");
  });

  it("creates contains edges from file node to each symbol", async () => {
    mockParseSourceFile.mockResolvedValueOnce(
      makeParseResult([
        { name: "alpha", kind: "function",       startLine: 0, endLine: 0 },
        { name: "beta",  kind: "arrow_function", startLine: 2, endLine: 2 },
      ]),
    );

    const fg = await fileGraphFromContent("src/ab.ts", "/* content */", "/root");

    const fileNode = fg.nodes.find((n) => n.kind === "file")!;
    const containsEdges = fg.edges.filter((e) => e.type === "contains");
    const symbolCount = fg.nodes.filter((n) => n.kind !== "file").length;

    expect(symbolCount).toBe(2);
    expect(containsEdges).toHaveLength(2);
    expect(containsEdges.every((e) => e.source === fileNode.id)).toBe(true);
  });

  it("skips heading symbols (markdown sections) — not part of the code graph", async () => {
    // parseSourceFile for a .ts file wouldn't return headings, but test that
    // the builder filters them out even if they appear.
    mockParseSourceFile.mockResolvedValueOnce({
      language: "typescript",
      symbols: [
        { name: "Overview", kind: "heading", startLine: 0, endLine: 5 },
        { name: "getRealFn", kind: "function", startLine: 10, endLine: 12 },
      ],
    });

    const fg = await fileGraphFromContent("src/code.ts", "/* content */", "/root");

    const symbolNodes = fg.nodes.filter((n) => n.kind !== "file");
    // heading is filtered; only getRealFn is included
    expect(symbolNodes).toHaveLength(1);
    expect(symbolNodes[0]!.name).toBe("getRealFn");
    expect(symbolNodes[0]!.kind).toBe("function");
  });

  it("populates range (1-indexed), signature, and docstring from ParsedSymbol", async () => {
    mockParseSourceFile.mockResolvedValueOnce(
      makeParseResult([
        {
          name: "compute",
          kind: "function",
          startLine: 2,  // 0-indexed
          endLine: 5,
          signature: "export function compute(x: number): number",
          docComment: "Computes the result.",
        },
      ]),
    );

    const content = [
      "// first line",
      "// second line",
      "/** Computes the result. */",
      "export function compute(x: number): number {",
      "  return x * 2;",
      "}",
    ].join("\n");

    const fg = await fileGraphFromContent("src/compute.ts", content, "/root");

    const computeNode = fg.nodes.find((n) => n.name === "compute")!;
    expect(computeNode).toBeDefined();
    expect(computeNode.kind).toBe("function");
    // Builder adds 1 to convert from 0-indexed (tree-sitter) to 1-indexed (CodeNode)
    expect(computeNode.range.start).toBe(3);  // startLine 2 → 3
    expect(computeNode.range.end).toBe(6);    // endLine 5 → 6
    expect(computeNode.signature).toBe("export function compute(x: number): number");
    expect(computeNode.docstring).toBe("Computes the result.");
  });

  it("returns a content hash in the FileGraph", async () => {
    mockParseSourceFile.mockResolvedValueOnce({ language: "typescript", symbols: [] });

    const content = "export const x = 1;\n";
    const fg = await fileGraphFromContent("src/x.ts", content, "/root");

    expect(typeof fg.contentHash).toBe("string");
    expect(fg.contentHash.length).toBeGreaterThan(0);
  });

  it("passes the file path and content to parseSourceFile", async () => {
    mockParseSourceFile.mockResolvedValueOnce({ language: "typescript", symbols: [] });

    const content = "const a = 1;";
    await fileGraphFromContent("lib/utils.ts", content, "/root");

    expect(mockParseSourceFile).toHaveBeenCalledOnce();
    expect(mockParseSourceFile).toHaveBeenCalledWith("lib/utils.ts", content);
  });
});

// ---------------------------------------------------------------------------
// Integration-style test (no mocking): listSourceFiles walks correctly
// ---------------------------------------------------------------------------

describe("listSourceFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "oxagen-builder-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finds .ts, .js, .py files but skips node_modules, .git, dist, and non-source extensions", async () => {
    // Source files
    writeFileSync(join(tmpDir, "main.ts"), "// ts");
    writeFileSync(join(tmpDir, "util.js"), "// js");
    writeFileSync(join(tmpDir, "script.py"), "# py");
    writeFileSync(join(tmpDir, "comp.tsx"), "// tsx");
    writeFileSync(join(tmpDir, "build.mjs"), "// mjs");
    // Should be skipped
    writeFileSync(join(tmpDir, "data.json"), "{}");
    writeFileSync(join(tmpDir, "styles.css"), "body {}");

    // Ignored directories
    mkdirSync(join(tmpDir, "node_modules/foo"), { recursive: true });
    writeFileSync(join(tmpDir, "node_modules/foo/index.ts"), "// ignored");
    mkdirSync(join(tmpDir, ".git"), { recursive: true });
    writeFileSync(join(tmpDir, ".git/config"), "ignored");
    mkdirSync(join(tmpDir, "dist"), { recursive: true });
    writeFileSync(join(tmpDir, "dist/bundle.js"), "// ignored");

    const files = await listSourceFiles(tmpDir);

    expect(files).toContain("main.ts");
    expect(files).toContain("util.js");
    expect(files).toContain("script.py");
    expect(files).toContain("comp.tsx");
    expect(files).toContain("build.mjs");
    expect(files).not.toContain("data.json");
    expect(files).not.toContain("styles.css");
    expect(files.every((f) => !f.includes("node_modules"))).toBe(true);
    expect(files.every((f) => !f.includes(".git"))).toBe(true);
    expect(files.every((f) => !f.includes("dist"))).toBe(true);
  });
});
