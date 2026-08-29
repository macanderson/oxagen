/**
 * Tests for the @oxagen/code-graph parseSourceFile function.
 *
 * Strategy: mock the entire `web-tree-sitter` module so we never load real
 * WASM files. Each test builds a lightweight fake parse tree that mirrors the
 * structure tree-sitter returns for a given fixture, then verifies the symbols
 * parseSourceFile() extracts.
 *
 * Covers TypeScript, JS/JSX (the TS grammar handles them), and Python.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Build helper — create a fake tree-sitter SyntaxNode tree from a descriptor
// ---------------------------------------------------------------------------

interface NodeDef {
  type: string;
  text?: string;
  startRow?: number;
  endRow?: number;
  children?: NodeDef[];
}

type FakeNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  children: FakeNode[];
  parent: FakeNode | null;
  childCount: number;
};

function buildNode(def: NodeDef, parent: FakeNode | null = null): FakeNode {
  const node: FakeNode = {
    type: def.type,
    text: def.text ?? "",
    startPosition: { row: def.startRow ?? 0, column: 0 },
    endPosition: { row: def.endRow ?? 0, column: 0 },
    children: [],
    parent,
    get childCount() {
      return this.children.length;
    },
  };
  node.children = (def.children ?? []).map((c) => buildNode(c, node));
  return node;
}

// ---------------------------------------------------------------------------
// Fake query infrastructure
// ---------------------------------------------------------------------------

type CaptureEntry = { name: string; node: FakeNode };
type Match = { captures: CaptureEntry[] };

/**
 * Build a fake Language.query() implementation that, for a well-known query
 * string, returns matches derived from the fake tree via a simple BFS walk.
 */
function makeFakeLanguage(queryMatches: Record<string, Match[]>): {
  query: (q: string) => { matches: (node: FakeNode) => Match[] };
} {
  return {
    query(q: string) {
      return {
        matches(_node: FakeNode) {
          // Normalize whitespace for lookup
          const key = q.replace(/\s+/g, " ").trim();
          return queryMatches[key] ?? [];
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Hoist mocks BEFORE any imports that touch web-tree-sitter
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  parserInit: vi.fn().mockResolvedValue(undefined),
  languageLoad: vi.fn(),
  parserInstances: [] as Array<{
    parse: ReturnType<typeof vi.fn>;
    setLanguage: ReturnType<typeof vi.fn>;
    getLanguage: ReturnType<typeof vi.fn>;
  }>,
}));

// We mock web-tree-sitter at the module level. The Parser constructor returns
// a new fake parser from `parserInstances` in order.
vi.mock("web-tree-sitter", () => {
  const ParserClass = vi.fn().mockImplementation(() => {
    const instance = mocks.parserInstances.shift()!;
    return instance;
  });
  (ParserClass as unknown as { init: typeof mocks.parserInit }).init =
    mocks.parserInit;
  (
    ParserClass as unknown as { Language: { load: typeof mocks.languageLoad } }
  ).Language = {
    load: mocks.languageLoad,
  };
  return { default: ParserClass };
});

// Also mock fs so no real WASM file is ever accessed. existsSync returns
// true so resolveWasm() accepts its first candidate path.
vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-wasm")),
  existsSync: vi.fn().mockReturnValue(true),
}));

// ---------------------------------------------------------------------------
// After mocks are set up, we can import the modules under test
// ---------------------------------------------------------------------------

import { parseSourceFile } from "../index";
import { _resetForTest, _injectLanguagesForTest } from "../loader";

// ---------------------------------------------------------------------------
// Helpers to create per-test parser instances
// ---------------------------------------------------------------------------

function makeParserInstance(
  fakeTree: { rootNode: FakeNode },
  fakeLanguage: ReturnType<typeof makeFakeLanguage>,
) {
  const instance = {
    parse: vi.fn().mockReturnValue(fakeTree),
    setLanguage: vi.fn(),
    getLanguage: vi.fn().mockReturnValue(fakeLanguage),
  };
  mocks.parserInstances.push(instance);
  return instance;
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/**
 * TypeScript fixture:
 *   Line 0-5:  class MyClass { ... }
 *   Line 1-3:  method doSomething()
 *   Line 4:    method another()
 *   Line 7-9:  interface MyInterface { ... }
 *
 * Expected symbols: MyClass (class), doSomething (method), another (method),
 *                   MyInterface (interface)  → 4 symbols total.
 */
function buildTypescriptQueryMatches(): Record<string, Match[]> {
  const classNameNode = buildNode({
    type: "type_identifier",
    text: "MyClass",
    startRow: 0,
    endRow: 0,
  });
  const classNode = buildNode({
    type: "class_declaration",
    startRow: 0,
    endRow: 5,
  });
  const method1NameNode = buildNode({
    type: "property_identifier",
    text: "doSomething",
    startRow: 1,
    endRow: 1,
  });
  const method1Node = buildNode({
    type: "method_definition",
    startRow: 1,
    endRow: 3,
  });
  const method2NameNode = buildNode({
    type: "property_identifier",
    text: "another",
    startRow: 4,
    endRow: 4,
  });
  const method2Node = buildNode({
    type: "method_definition",
    startRow: 4,
    endRow: 4,
  });
  const ifaceNameNode = buildNode({
    type: "type_identifier",
    text: "MyInterface",
    startRow: 7,
    endRow: 7,
  });
  const ifaceNode = buildNode({
    type: "interface_declaration",
    startRow: 7,
    endRow: 9,
  });

  return {
    "(class_declaration name: (type_identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: classNameNode },
          { name: "node", node: classNode },
        ],
      },
    ],
    "(method_definition name: (property_identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: method1NameNode },
          { name: "node", node: method1Node },
        ],
      },
      {
        captures: [
          { name: "name", node: method2NameNode },
          { name: "node", node: method2Node },
        ],
      },
    ],
    "(interface_declaration name: (type_identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: ifaceNameNode },
          { name: "node", node: ifaceNode },
        ],
      },
    ],
    "(function_declaration name: (identifier) @name) @node": [],
    "(type_alias_declaration name: (type_identifier) @name) @node": [],
    "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node":
      [],
  };
}

/**
 * Python fixture:
 *   Line 0-2:  def fetch_data():
 *   Line 4-6:  def process():
 *   Line 8-12: class DataPipeline:
 */
function buildPythonQueryMatches(): Record<string, Match[]> {
  const fn1NameNode = buildNode({
    type: "identifier",
    text: "fetch_data",
    startRow: 0,
    endRow: 0,
  });
  const fn1Node = buildNode({
    type: "function_definition",
    startRow: 0,
    endRow: 2,
  });
  const fn2NameNode = buildNode({
    type: "identifier",
    text: "process",
    startRow: 4,
    endRow: 4,
  });
  const fn2Node = buildNode({
    type: "function_definition",
    startRow: 4,
    endRow: 6,
  });
  const classNameNode = buildNode({
    type: "identifier",
    text: "DataPipeline",
    startRow: 8,
    endRow: 8,
  });
  const classNode = buildNode({
    type: "class_definition",
    startRow: 8,
    endRow: 12,
  });

  return {
    "(function_definition name: (identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: fn1NameNode },
          { name: "node", node: fn1Node },
        ],
      },
      {
        captures: [
          { name: "name", node: fn2NameNode },
          { name: "node", node: fn2Node },
        ],
      },
    ],
    "(class_definition name: (identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: classNameNode },
          { name: "node", node: classNode },
        ],
      },
    ],
  };
}

/**
 * Arrow function fixture:
 *   Line 0-2: const fetchData = async (url: string) => { ... }
 *   Line 4-6: const processItems = (items: string[]) => { ... }
 *   Line 8:   export function namedFn() {}
 *
 * Expected: fetchData (arrow_function) + processItems (arrow_function) + namedFn (function)
 */
function buildArrowQueryMatches(): Record<string, Match[]> {
  const arrowName1 = buildNode({
    type: "identifier",
    text: "fetchData",
    startRow: 0,
    endRow: 0,
  });
  const arrowNode1 = buildNode({
    type: "lexical_declaration",
    startRow: 0,
    endRow: 2,
  });
  const arrowName2 = buildNode({
    type: "identifier",
    text: "processItems",
    startRow: 4,
    endRow: 4,
  });
  const arrowNode2 = buildNode({
    type: "lexical_declaration",
    startRow: 4,
    endRow: 6,
  });
  const fnName = buildNode({
    type: "identifier",
    text: "namedFn",
    startRow: 8,
    endRow: 8,
  });
  const fnNode = buildNode({
    type: "function_declaration",
    startRow: 8,
    endRow: 9,
  });

  return {
    "(function_declaration name: (identifier) @name) @node": [
      {
        captures: [
          { name: "name", node: fnName },
          { name: "node", node: fnNode },
        ],
      },
    ],
    "(class_declaration name: (type_identifier) @name) @node": [],
    "(method_definition name: (property_identifier) @name) @node": [],
    "(interface_declaration name: (type_identifier) @name) @node": [],
    "(type_alias_declaration name: (type_identifier) @name) @node": [],
    "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node":
      [
        {
          captures: [
            { name: "name", node: arrowName1 },
            { name: "node", node: arrowNode1 },
            { name: "fn", node: arrowNode1 },
          ],
        },
        {
          captures: [
            { name: "name", node: arrowName2 },
            { name: "node", node: arrowNode2 },
            { name: "fn", node: arrowNode2 },
          ],
        },
      ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseSourceFile", () => {
  beforeEach(() => {
    _resetForTest();
    mocks.parserInstances.length = 0;
    vi.clearAllMocks();
    mocks.parserInit.mockResolvedValue(undefined);
  });

  // ── TypeScript ─────────────────────────────────────────────────────────────

  describe("TypeScript (.ts)", () => {
    it("extracts 4 symbols: 1 class + 2 methods + 1 interface with correct kinds and line ranges", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile(
        "src/components/MyClass.ts",
        "/* fixture */",
      );

      expect(result.language).toBe("typescript");
      expect(result.error).toBeUndefined();
      expect(result.symbols).toHaveLength(4);

      const classSymbol = result.symbols.find((s) => s.kind === "class");
      expect(classSymbol).toBeDefined();
      expect(classSymbol!.name).toBe("MyClass");
      expect(classSymbol!.startLine).toBe(0);
      expect(classSymbol!.endLine).toBe(5);

      const methodSymbols = result.symbols.filter((s) => s.kind === "method");
      expect(methodSymbols).toHaveLength(2);
      const doSomething = methodSymbols.find((s) => s.name === "doSomething");
      expect(doSomething).toBeDefined();
      expect(doSomething!.startLine).toBe(1);
      expect(doSomething!.endLine).toBe(3);
      const another = methodSymbols.find((s) => s.name === "another");
      expect(another).toBeDefined();
      expect(another!.startLine).toBe(4);
      expect(another!.endLine).toBe(4);

      const ifaceSymbol = result.symbols.find((s) => s.kind === "interface");
      expect(ifaceSymbol).toBeDefined();
      expect(ifaceSymbol!.name).toBe("MyInterface");
      expect(ifaceSymbol!.startLine).toBe(7);
      expect(ifaceSymbol!.endLine).toBe(9);
    });

    it("also works for .tsx extension", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile(
        "components/Button.tsx",
        "/* tsx */",
      );

      expect(result.language).toBe("typescript");
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it("deduplicates symbols matched by multiple overlapping queries", async () => {
      const classNameNode = buildNode({
        type: "type_identifier",
        text: "Dup",
        startRow: 0,
        endRow: 0,
      });
      const classNode = buildNode({
        type: "class_declaration",
        startRow: 0,
        endRow: 5,
      });
      const matches: Record<string, Match[]> = {
        "(class_declaration name: (type_identifier) @name) @node": [
          {
            captures: [
              { name: "name", node: classNameNode },
              { name: "node", node: classNode },
            ],
          },
          {
            captures: [
              { name: "name", node: classNameNode },
              { name: "node", node: classNode },
            ],
          },
        ],
        "(function_declaration name: (identifier) @name) @node": [],
        "(method_definition name: (property_identifier) @name) @node": [],
        "(interface_declaration name: (type_identifier) @name) @node": [],
        "(type_alias_declaration name: (type_identifier) @name) @node": [],
        "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node":
          [],
      };

      const fakeLang = makeFakeLanguage(matches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});
      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("Dup.ts", "");

      const classSymbols = result.symbols.filter((s) => s.name === "Dup");
      expect(classSymbols).toHaveLength(1);
    });
  });

  // ── JavaScript (.js / .jsx) — the TS grammar handles them ─────────────────

  describe("JavaScript (.js / .jsx)", () => {
    it("parses .js files with the TypeScript grammar (same language detector)", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("src/utils.js", "/* js fixture */");

      expect(result.language).toBe("typescript"); // TS grammar used for JS
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it("parses .jsx files with the TypeScript grammar", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("components/App.jsx", "/* jsx */");

      expect(result.language).toBe("typescript");
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it("parses .mjs files with the TypeScript grammar", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("scripts/build.mjs", "/* mjs */");
      expect(result.language).toBe("typescript");
    });
  });

  // ── Arrow functions ────────────────────────────────────────────────────────

  describe("Arrow functions", () => {
    it("extracts arrow_function symbols from lexical_declaration queries", async () => {
      const arrowMatches = buildArrowQueryMatches();
      const fakeLang = makeFakeLanguage(arrowMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const content = [
        "const fetchData = async (url: string) => {",
        "  return fetch(url);",
        "};",
        "",
        "const processItems = (items: string[]) => items.map(String);",
        "",
        "export function namedFn() {}",
      ].join("\n");

      const result = await parseSourceFile("src/utils.ts", content);

      expect(result.language).toBe("typescript");

      const arrowSymbols = result.symbols.filter(
        (s) => s.kind === "arrow_function",
      );
      expect(arrowSymbols).toHaveLength(2);
      expect(arrowSymbols.map((s) => s.name)).toContain("fetchData");
      expect(arrowSymbols.map((s) => s.name)).toContain("processItems");

      const fnSymbols = result.symbols.filter((s) => s.kind === "function");
      expect(fnSymbols).toHaveLength(1);
      expect(fnSymbols[0]!.name).toBe("namedFn");
    });
  });

  // ── Python ─────────────────────────────────────────────────────────────────

  describe("Python (.py)", () => {
    it("extracts 3 symbols: 2 functions + 1 class with correct kinds and line ranges", async () => {
      const pyQueryMatches = buildPythonQueryMatches();
      const fakeLang = makeFakeLanguage(pyQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "module" }) };

      mocks.languageLoad
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(fakeLang);

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("pipeline/data.py", "# fixture");

      expect(result.language).toBe("python");
      expect(result.error).toBeUndefined();
      expect(result.symbols).toHaveLength(3);

      const functions = result.symbols.filter((s) => s.kind === "function");
      expect(functions).toHaveLength(2);
      expect(functions.map((f) => f.name)).toContain("fetch_data");
      expect(functions.map((f) => f.name)).toContain("process");

      const fetchFn = functions.find((f) => f.name === "fetch_data")!;
      expect(fetchFn.startLine).toBe(0);
      expect(fetchFn.endLine).toBe(2);

      const classSym = result.symbols.find((s) => s.kind === "class")!;
      expect(classSym.name).toBe("DataPipeline");
      expect(classSym.startLine).toBe(8);
      expect(classSym.endLine).toBe(12);
    });
  });

  // ── Unknown extension ──────────────────────────────────────────────────────

  describe("Unknown extension", () => {
    it("returns { language: 'unknown', symbols: [] } without calling Parser", async () => {
      const result = await parseSourceFile("data.bin", "binary-ish");

      expect(result.language).toBe("unknown");
      expect(result.symbols).toEqual([]);
      expect(result.error).toBeUndefined();
      expect(mocks.parserInstances).toHaveLength(0);
      expect(mocks.parserInit).not.toHaveBeenCalled();
    });

    it("returns { language: 'unknown', symbols: [] } for .json extension", async () => {
      const result = await parseSourceFile("package.json", "{}");
      expect(result.language).toBe("unknown");
      expect(result.symbols).toEqual([]);
    });
  });

  // ── Markdown ───────────────────────────────────────────────────────────────

  describe("Markdown (.md / .mdx)", () => {
    it("parses markdown into heading-section symbols without invoking tree-sitter", async () => {
      const md = "# Getting Started\nIntro.\n\n## Install\nRun npm i.";
      const result = await parseSourceFile("docs/README.md", md);

      expect(result.language).toBe("markdown");
      expect(result.title).toBe("Getting Started");
      expect(result.symbols.map((s) => s.name)).toEqual([
        "Getting Started",
        "Install",
      ]);
      expect(result.symbols.every((s) => s.kind === "heading")).toBe(true);
      expect(mocks.parserInstances).toHaveLength(0);
      expect(mocks.parserInit).not.toHaveBeenCalled();
    });

    it("treats .mdx the same as .md", async () => {
      const result = await parseSourceFile("page.mdx", "## Section\nbody");
      expect(result.language).toBe("markdown");
      expect(result.symbols).toHaveLength(1);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe("Error handling", () => {
    it("returns error field when parser throws", async () => {
      mocks.languageLoad.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      mocks.parserInit.mockRejectedValueOnce(new Error("WASM load failed"));
      _resetForTest();

      const result = await parseSourceFile("broken.ts", "const x = 1;");

      expect(result.language).toBe("typescript");
      expect(result.symbols).toEqual([]);
      expect(result.error).toMatch(/WASM load failed/);
    });

    it("logs a console.error when the parser throws (regression: silent WASM failure)", async () => {
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      mocks.languageLoad.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      mocks.parserInit.mockRejectedValueOnce(new Error("WASM load failed"));
      _resetForTest();

      await parseSourceFile("missing-wasm.ts", "const x = 1;");

      expect(consoleSpy).toHaveBeenCalledOnce();
      expect(consoleSpy.mock.calls[0]![0]).toMatch(/parseSourceFile failed/);
      expect(consoleSpy.mock.calls[0]![0]).toMatch(/missing-wasm\.ts/);
      expect(consoleSpy.mock.calls[0]![0]).toMatch(/WASM load failed/);

      consoleSpy.mockRestore();
    });

    it("error field in ParseResult is populated on parse failure", async () => {
      mocks.languageLoad.mockResolvedValueOnce({}).mockResolvedValueOnce({});
      mocks.parserInit.mockRejectedValueOnce(
        new Error("tree-sitter wasm not found: typescript.wasm"),
      );
      _resetForTest();

      const result = await parseSourceFile(
        "src/index.ts",
        "export const x = 1;",
      );

      expect(result.error).toBeDefined();
      expect(result.error).toMatch(/tree-sitter wasm not found/);
      expect(result.symbols).toHaveLength(0);
    });
  });

  // ── Loader caching ─────────────────────────────────────────────────────────

  describe("Loader singleton", () => {
    it("calls Parser.init() only once across multiple parseSourceFile calls", async () => {
      const tsQueryMatches = buildTypescriptQueryMatches();
      const fakeLang = makeFakeLanguage(tsQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);
      makeParserInstance(fakeTree, fakeLang);

      await parseSourceFile("a.ts", "");
      await parseSourceFile("b.ts", "");

      expect(mocks.parserInit).toHaveBeenCalledTimes(1);
    });
  });
});
