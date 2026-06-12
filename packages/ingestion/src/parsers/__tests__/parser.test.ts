/**
 * Tests for the source code parser.
 *
 * Strategy: mock the entire `web-tree-sitter` module so we never load real
 * WASM files. Each test builds a lightweight fake parse tree that mirrors the
 * structure tree-sitter returns for a given fixture, then verifies the symbols
 * parseSourceFile() extracts.
 *
 * Because parseSourceFile() calls getParser() which calls Parser.init() and
 * Parser.Language.load(), we mock both to return/reject as needed. We also
 * inject mock Language objects via the loader's _injectLanguagesForTest helper
 * so the module state is clean for each test.
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
function makeFakeLanguage(
  queryMatches: Record<string, Match[]>,
): {
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
// true so loader.resolveWasm() accepts its first candidate path.
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
  // Nodes used in captures
  const classNameNode = buildNode({ type: "type_identifier", text: "MyClass", startRow: 0, endRow: 0 });
  const classNode = buildNode({ type: "class_declaration", startRow: 0, endRow: 5 });
  const method1NameNode = buildNode({ type: "property_identifier", text: "doSomething", startRow: 1, endRow: 1 });
  const method1Node = buildNode({ type: "method_definition", startRow: 1, endRow: 3 });
  const method2NameNode = buildNode({ type: "property_identifier", text: "another", startRow: 4, endRow: 4 });
  const method2Node = buildNode({ type: "method_definition", startRow: 4, endRow: 4 });
  const ifaceNameNode = buildNode({ type: "type_identifier", text: "MyInterface", startRow: 7, endRow: 7 });
  const ifaceNode = buildNode({ type: "interface_declaration", startRow: 7, endRow: 9 });

  return {
    "(class_declaration name: (type_identifier) @name) @node": [
      { captures: [{ name: "name", node: classNameNode }, { name: "node", node: classNode }] },
    ],
    "(method_definition name: (property_identifier) @name) @node": [
      { captures: [{ name: "name", node: method1NameNode }, { name: "node", node: method1Node }] },
      { captures: [{ name: "name", node: method2NameNode }, { name: "node", node: method2Node }] },
    ],
    "(interface_declaration name: (type_identifier) @name) @node": [
      { captures: [{ name: "name", node: ifaceNameNode }, { name: "node", node: ifaceNode }] },
    ],
    // No function, type, or arrow function hits in this fixture
    "(function_declaration name: (identifier) @name) @node": [],
    "(type_alias_declaration name: (type_identifier) @name) @node": [],
    "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node": [],
  };
}

/**
 * Python fixture:
 *   Line 0-2:  def fetch_data():
 *   Line 4-6:  def process():
 *   Line 8-12: class DataPipeline:
 *
 * Expected symbols: fetch_data (function), process (function), DataPipeline (class)
 *   → 3 symbols total.
 */
function buildPythonQueryMatches(): Record<string, Match[]> {
  const fn1NameNode = buildNode({ type: "identifier", text: "fetch_data", startRow: 0, endRow: 0 });
  const fn1Node = buildNode({ type: "function_definition", startRow: 0, endRow: 2 });
  const fn2NameNode = buildNode({ type: "identifier", text: "process", startRow: 4, endRow: 4 });
  const fn2Node = buildNode({ type: "function_definition", startRow: 4, endRow: 6 });
  const classNameNode = buildNode({ type: "identifier", text: "DataPipeline", startRow: 8, endRow: 8 });
  const classNode = buildNode({ type: "class_definition", startRow: 8, endRow: 12 });

  return {
    "(function_definition name: (identifier) @name) @node": [
      { captures: [{ name: "name", node: fn1NameNode }, { name: "node", node: fn1Node }] },
      { captures: [{ name: "name", node: fn2NameNode }, { name: "node", node: fn2Node }] },
    ],
    "(class_definition name: (identifier) @name) @node": [
      { captures: [{ name: "name", node: classNameNode }, { name: "node", node: classNode }] },
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
        .mockResolvedValueOnce(fakeLang)  // tsLanguage
        .mockResolvedValueOnce({});       // pyLanguage

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("src/components/MyClass.ts", "/* fixture */");

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

      // Loader already initialized in this test because _resetForTest() was called in beforeEach
      mocks.languageLoad
        .mockResolvedValueOnce(fakeLang)
        .mockResolvedValueOnce({});

      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("components/Button.tsx", "/* tsx */");

      expect(result.language).toBe("typescript");
      expect(result.symbols.length).toBeGreaterThan(0);
    });

    it("deduplicates symbols matched by multiple overlapping queries", async () => {
      // If the same node is returned by two different query patterns, dedup by
      // (kind, name, startLine).
      const classNameNode = buildNode({ type: "type_identifier", text: "Dup", startRow: 0, endRow: 0 });
      const classNode = buildNode({ type: "class_declaration", startRow: 0, endRow: 5 });
      const matches: Record<string, Match[]> = {
        "(class_declaration name: (type_identifier) @name) @node": [
          { captures: [{ name: "name", node: classNameNode }, { name: "node", node: classNode }] },
          // Duplicate entry
          { captures: [{ name: "name", node: classNameNode }, { name: "node", node: classNode }] },
        ],
        "(function_declaration name: (identifier) @name) @node": [],
        "(method_definition name: (property_identifier) @name) @node": [],
        "(interface_declaration name: (type_identifier) @name) @node": [],
        "(type_alias_declaration name: (type_identifier) @name) @node": [],
        "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node": [],
      };

      const fakeLang = makeFakeLanguage(matches);
      const fakeTree = { rootNode: buildNode({ type: "program" }) };

      mocks.languageLoad.mockResolvedValueOnce(fakeLang).mockResolvedValueOnce({});
      makeParserInstance(fakeTree, fakeLang);

      const result = await parseSourceFile("Dup.ts", "");

      const classSymbols = result.symbols.filter((s) => s.name === "Dup");
      expect(classSymbols).toHaveLength(1);
    });
  });

  // ── Python ─────────────────────────────────────────────────────────────────

  describe("Python (.py)", () => {
    it("extracts 3 symbols: 2 functions + 1 class with correct kinds and line ranges", async () => {
      const pyQueryMatches = buildPythonQueryMatches();
      const fakeLang = makeFakeLanguage(pyQueryMatches);
      const fakeTree = { rootNode: buildNode({ type: "module" }) };

      mocks.languageLoad
        .mockResolvedValueOnce({})       // tsLanguage
        .mockResolvedValueOnce(fakeLang); // pyLanguage

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

      const processFn = functions.find((f) => f.name === "process")!;
      expect(processFn.startLine).toBe(4);
      expect(processFn.endLine).toBe(6);

      const classSymbols = result.symbols.filter((s) => s.kind === "class");
      expect(classSymbols).toHaveLength(1);
      expect(classSymbols[0]!.name).toBe("DataPipeline");
      expect(classSymbols[0]!.startLine).toBe(8);
      expect(classSymbols[0]!.endLine).toBe(12);
    });
  });

  // ── Unknown extension ──────────────────────────────────────────────────────

  describe("Unknown extension", () => {
    it("returns { language: 'unknown', symbols: [] } without calling Parser", async () => {
      // Parser should not be instantiated for unknown extensions.
      const result = await parseSourceFile("README.md", "# Hello");

      expect(result.language).toBe("unknown");
      expect(result.symbols).toEqual([]);
      expect(result.error).toBeUndefined();
      // No parser was created
      expect(mocks.parserInstances).toHaveLength(0);
      // parserInit should not have been called (short-circuit before init)
      expect(mocks.parserInit).not.toHaveBeenCalled();
    });

    it("returns { language: 'unknown', symbols: [] } for .json extension", async () => {
      const result = await parseSourceFile("package.json", "{}");
      expect(result.language).toBe("unknown");
      expect(result.symbols).toEqual([]);
    });

    it("returns { language: 'unknown', symbols: [] } for .css extension", async () => {
      const result = await parseSourceFile("styles/main.css", "body {}");
      expect(result.language).toBe("unknown");
      expect(result.symbols).toEqual([]);
    });
  });

  // ── Error handling ─────────────────────────────────────────────────────────

  describe("Error handling", () => {
    it("returns error field when parser throws", async () => {
      mocks.languageLoad
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({});
      mocks.parserInit.mockRejectedValueOnce(new Error("WASM load failed"));
      _resetForTest(); // ensure init path runs again

      const result = await parseSourceFile("broken.ts", "const x = 1;");

      expect(result.language).toBe("typescript");
      expect(result.symbols).toEqual([]);
      expect(result.error).toMatch(/WASM load failed/);
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

      // Enqueue two parser instances for two calls
      makeParserInstance(fakeTree, fakeLang);
      makeParserInstance(fakeTree, fakeLang);

      await parseSourceFile("a.ts", "");
      await parseSourceFile("b.ts", "");

      // init() should have been called only once on the first call
      expect(mocks.parserInit).toHaveBeenCalledTimes(1);
    });
  });
});
