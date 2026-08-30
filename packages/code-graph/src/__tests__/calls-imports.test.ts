/**
 * Tests for CALL-site extraction and IMPORT specifier extraction in
 * @oxagen/code-graph parseSourceFile().
 *
 * Strategy: same mock approach as parser.test.ts — mock web-tree-sitter so no
 * real WASM is loaded.  Each test builds a fake parse tree that mirrors what
 * tree-sitter returns for the fixture, then asserts on `result.calls` and
 * `result.imports`.
 *
 * Coverage:
 *  - calls: identifier callee (foo()), member callee (obj.bar()), enclosing symbol resolution
 *  - calls: module-level calls have enclosingSymbol = null
 *  - calls: deduplication of same callee+line from overlapping captures
 *  - imports: import_statement specifiers (relative + bare + @oxagen/*)
 *  - imports: export_statement re-exports
 *  - imports: deduplication
 *  - Python: call extraction (identifier + attribute callee), enclosing symbol resolution
 *  - Python: import_statement + import_from_statement specifier extraction
 *  - Markdown: calls/imports are omitted (undefined)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Fake node / query infrastructure (same pattern as parser.test.ts)
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

type CaptureEntry = { name: string; node: FakeNode };
type Match = { captures: CaptureEntry[] };

function makeFakeLanguage(queryMatches: Record<string, Match[]>): {
  query: (q: string) => { matches: (node: FakeNode) => Match[] };
} {
  return {
    query(q: string) {
      return {
        matches(_node: FakeNode) {
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

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue(Buffer.from("fake-wasm")),
  existsSync: vi.fn().mockReturnValue(true),
}));

import { parseSourceFile } from "../index";
import { _resetForTest, _injectLanguagesForTest } from "../loader";

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
// Normalised query strings (used as lookup keys in makeFakeLanguage)
// ---------------------------------------------------------------------------

// These must match the actual query strings in index.ts after whitespace normalisation.
const CALL_QUERY =
  "(call_expression function: [(identifier) @callee (member_expression property: (property_identifier) @callee)]) @node";
const IMPORT_QUERY =
  "(import_statement source: (string (string_fragment) @specifier)) @node";
const REEXPORT_QUERY =
  "(export_statement source: (string (string_fragment) @specifier)) @node";

// Blank matches for symbol queries (we inject a minimal symbol set via separate entries).
function blankSymbolMatches(): Record<string, Match[]> {
  return {
    "(function_declaration name: (identifier) @name) @node": [],
    "(class_declaration name: (type_identifier) @name) @node": [],
    "(method_definition name: (property_identifier) @name) @node": [],
    "(interface_declaration name: (type_identifier) @name) @node": [],
    "(type_alias_declaration name: (type_identifier) @name) @node": [],
    "(lexical_declaration (variable_declarator name: (identifier) @name value: (arrow_function) @fn)) @node":
      [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("parseSourceFile — CALLS extraction", () => {
  beforeEach(() => {
    _resetForTest();
    mocks.parserInstances.length = 0;
    vi.clearAllMocks();
    mocks.parserInit.mockResolvedValue(undefined);
  });

  it("extracts identifier callee with enclosingSymbol when call is inside a function", async () => {
    // Fixture:
    //   line 0-3: function doWork() { helper(); }
    //   line 5:   function helper() {}
    //
    // Expected call: callee="helper", line=1, enclosingSymbol="doWork"

    const doWorkNameNode = buildNode({
      type: "identifier",
      text: "doWork",
      startRow: 0,
    });
    const doWorkNode = buildNode({
      type: "function_declaration",
      startRow: 0,
      endRow: 3,
    });
    const helperCalleeNode = buildNode({
      type: "identifier",
      text: "helper",
      startRow: 1,
    });
    const helperCallNode = buildNode({
      type: "call_expression",
      startRow: 1,
      endRow: 1,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      "(function_declaration name: (identifier) @name) @node": [
        {
          captures: [
            { name: "name", node: doWorkNameNode },
            { name: "node", node: doWorkNode },
          ],
        },
      ],
      [CALL_QUERY]: [
        {
          captures: [
            { name: "callee", node: helperCalleeNode },
            { name: "node", node: helperCallNode },
          ],
        },
      ],
      [IMPORT_QUERY]: [],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const content = [
      "function doWork() {",
      "  helper();",
      "}",
      "",
      "function helper() {}",
    ].join("\n");

    const result = await parseSourceFile("src/work.ts", content);

    expect(result.calls).toBeDefined();
    expect(result.calls!.length).toBeGreaterThanOrEqual(1);

    const helperCall = result.calls!.find((c) => c.callee === "helper");
    expect(helperCall).toBeDefined();
    expect(helperCall!.line).toBe(1);
    expect(helperCall!.enclosingSymbol).toBe("doWork");
  });

  it("sets enclosingSymbol = null for module-level calls (not inside any symbol)", async () => {
    // Fixture: a call at line 0 with no enclosing function/class.
    const calleeNode = buildNode({
      type: "identifier",
      text: "init",
      startRow: 0,
    });
    const callNode = buildNode({
      type: "call_expression",
      startRow: 0,
      endRow: 0,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [
        {
          captures: [
            { name: "callee", node: calleeNode },
            { name: "node", node: callNode },
          ],
        },
      ],
      [IMPORT_QUERY]: [],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/bootstrap.ts", "init();");

    expect(result.calls).toBeDefined();
    const initCall = result.calls!.find((c) => c.callee === "init");
    expect(initCall).toBeDefined();
    expect(initCall!.enclosingSymbol).toBeNull();
  });

  it("extracts member expression callee (obj.method())", async () => {
    // Member property identifier capture — e.g. `logger.info(...)`
    const methodNameNode = buildNode({
      type: "property_identifier",
      text: "info",
      startRow: 2,
    });
    const callNode = buildNode({
      type: "call_expression",
      startRow: 2,
      endRow: 2,
    });
    const fnNameNode = buildNode({
      type: "identifier",
      text: "run",
      startRow: 0,
    });
    const fnNode = buildNode({
      type: "function_declaration",
      startRow: 0,
      endRow: 4,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      "(function_declaration name: (identifier) @name) @node": [
        {
          captures: [
            { name: "name", node: fnNameNode },
            { name: "node", node: fnNode },
          ],
        },
      ],
      [CALL_QUERY]: [
        {
          captures: [
            { name: "callee", node: methodNameNode },
            { name: "node", node: callNode },
          ],
        },
      ],
      [IMPORT_QUERY]: [],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/logger.ts", "");

    expect(result.calls).toBeDefined();
    const infoCall = result.calls!.find((c) => c.callee === "info");
    expect(infoCall).toBeDefined();
    expect(infoCall!.enclosingSymbol).toBe("run");
  });

  it("deduplicates calls on the same callee+line", async () => {
    const calleeNode = buildNode({
      type: "identifier",
      text: "compute",
      startRow: 1,
    });
    const callNode = buildNode({
      type: "call_expression",
      startRow: 1,
      endRow: 1,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [
        // Same callee + line twice (e.g. from overlapping capture groups)
        {
          captures: [
            { name: "callee", node: calleeNode },
            { name: "node", node: callNode },
          ],
        },
        {
          captures: [
            { name: "callee", node: calleeNode },
            { name: "node", node: callNode },
          ],
        },
      ],
      [IMPORT_QUERY]: [],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/dup.ts", "");

    const computeCalls = result.calls!.filter((c) => c.callee === "compute");
    expect(computeCalls).toHaveLength(1);
  });

  it("produces a calls array (empty) for a Python file with no calls", async () => {
    const fnNameNode = buildNode({
      type: "identifier",
      text: "run",
      startRow: 0,
    });
    const fnNode = buildNode({
      type: "function_definition",
      startRow: 0,
      endRow: 2,
    });

    const pyQueryMatches: Record<string, Match[]> = {
      "(function_definition name: (identifier) @name) @node": [
        {
          captures: [
            { name: "name", node: fnNameNode },
            { name: "node", node: fnNode },
          ],
        },
      ],
      "(class_definition name: (identifier) @name) @node": [],
    };

    const fakeLang = makeFakeLanguage(pyQueryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(fakeLang);
    makeParserInstance({ rootNode: buildNode({ type: "module" }) }, fakeLang);

    const result = await parseSourceFile("script.py", "def run(): pass");

    expect(result.language).toBe("python");
    expect(result.calls).toEqual([]);
  });

  it("omits calls for Markdown files (no tree-sitter invoked)", async () => {
    const result = await parseSourceFile("README.md", "# Title\nBody text.");

    expect(result.language).toBe("markdown");
    expect(result.calls).toBeUndefined();
  });
});

describe("parseSourceFile — IMPORTS extraction", () => {
  beforeEach(() => {
    _resetForTest();
    mocks.parserInstances.length = 0;
    vi.clearAllMocks();
    mocks.parserInit.mockResolvedValue(undefined);
  });

  it("extracts relative, @oxagen/*, and bare specifiers from import statements", async () => {
    const relNode = buildNode({
      type: "string_fragment",
      text: "./utils",
      startRow: 0,
    });
    const relStmt = buildNode({
      type: "import_statement",
      startRow: 0,
      endRow: 0,
    });
    const oxaNode = buildNode({
      type: "string_fragment",
      text: "@oxagen/ai",
      startRow: 1,
    });
    const oxaStmt = buildNode({
      type: "import_statement",
      startRow: 1,
      endRow: 1,
    });
    const reactNode = buildNode({
      type: "string_fragment",
      text: "react",
      startRow: 2,
    });
    const reactStmt = buildNode({
      type: "import_statement",
      startRow: 2,
      endRow: 2,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [],
      [IMPORT_QUERY]: [
        {
          captures: [
            { name: "specifier", node: relNode },
            { name: "node", node: relStmt },
          ],
        },
        {
          captures: [
            { name: "specifier", node: oxaNode },
            { name: "node", node: oxaStmt },
          ],
        },
        {
          captures: [
            { name: "specifier", node: reactNode },
            { name: "node", node: reactStmt },
          ],
        },
      ],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/index.ts", "");

    expect(result.imports).toBeDefined();
    const specifiers = result.imports!.map((i) => i.specifier);
    expect(specifiers).toContain("./utils");
    expect(specifiers).toContain("@oxagen/ai");
    expect(specifiers).toContain("react");
  });

  it("extracts re-export specifiers from export_statement", async () => {
    const reExportNode = buildNode({
      type: "string_fragment",
      text: "./shared/types",
      startRow: 3,
    });
    const reExportStmt = buildNode({
      type: "export_statement",
      startRow: 3,
      endRow: 3,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [],
      [IMPORT_QUERY]: [],
      [REEXPORT_QUERY]: [
        {
          captures: [
            { name: "specifier", node: reExportNode },
            { name: "node", node: reExportStmt },
          ],
        },
      ],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/barrel.ts", "");

    expect(result.imports).toBeDefined();
    expect(result.imports!.some((i) => i.specifier === "./shared/types")).toBe(
      true,
    );
  });

  it("deduplicates the same specifier+line appearing in both query matches", async () => {
    const specNode = buildNode({
      type: "string_fragment",
      text: "@oxagen/ai",
      startRow: 0,
    });
    const stmtNode = buildNode({
      type: "import_statement",
      startRow: 0,
      endRow: 0,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [],
      [IMPORT_QUERY]: [
        {
          captures: [
            { name: "specifier", node: specNode },
            { name: "node", node: stmtNode },
          ],
        },
        {
          captures: [
            { name: "specifier", node: specNode },
            { name: "node", node: stmtNode },
          ],
        },
      ],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/dup-import.ts", "");

    const aiImports = result.imports!.filter(
      (i) => i.specifier === "@oxagen/ai",
    );
    expect(aiImports).toHaveLength(1);
  });

  it("records the correct 0-indexed line for each import", async () => {
    const node5 = buildNode({
      type: "string_fragment",
      text: "@oxagen/ai",
      startRow: 5,
    });
    const stmt5 = buildNode({
      type: "import_statement",
      startRow: 5,
      endRow: 5,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankSymbolMatches(),
      [CALL_QUERY]: [],
      [IMPORT_QUERY]: [
        {
          captures: [
            { name: "specifier", node: node5 },
            { name: "node", node: stmt5 },
          ],
        },
      ],
      [REEXPORT_QUERY]: [],
    };

    const fakeLang = makeFakeLanguage(queryMatches);
    mocks.languageLoad
      .mockResolvedValueOnce(fakeLang)
      .mockResolvedValueOnce({});
    makeParserInstance({ rootNode: buildNode({ type: "program" }) }, fakeLang);

    const result = await parseSourceFile("src/line.ts", "");

    const aiImport = result.imports!.find((i) => i.specifier === "@oxagen/ai");
    expect(aiImport!.line).toBe(5);
  });

  it("produces an imports array (empty) for a Python file with no imports", async () => {
    const fnNameNode = buildNode({
      type: "identifier",
      text: "fn",
      startRow: 0,
    });
    const fnNode = buildNode({
      type: "function_definition",
      startRow: 0,
      endRow: 1,
    });
    const fakeLang = makeFakeLanguage({
      "(function_definition name: (identifier) @name) @node": [
        {
          captures: [
            { name: "name", node: fnNameNode },
            { name: "node", node: fnNode },
          ],
        },
      ],
      "(class_definition name: (identifier) @name) @node": [],
    });
    mocks.languageLoad
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(fakeLang);
    makeParserInstance({ rootNode: buildNode({ type: "module" }) }, fakeLang);

    const result = await parseSourceFile("script.py", "def fn(): pass");

    expect(result.imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Python call + import extraction
// ---------------------------------------------------------------------------

// Normalised Python query strings — must match the constants in index.ts after
// whitespace normalisation.
const PY_CALL_QUERY =
  "(call function: [(identifier) @callee (attribute attribute: (identifier) @callee)]) @node";
const PY_IMPORT_QUERY =
  "(import_statement name: [(dotted_name) @specifier (aliased_import name: (dotted_name) @specifier)]) @node";
const PY_IMPORT_FROM_QUERY =
  "(import_from_statement module_name: (dotted_name) @specifier) @node";

// Blank matches for the Python symbol queries; individual tests override the ones they need.
function blankPySymbolMatches(): Record<string, Match[]> {
  return {
    "(function_definition name: (identifier) @name) @node": [],
    "(class_definition name: (identifier) @name) @node": [],
  };
}

describe("parseSourceFile — Python CALLS + IMPORTS extraction", () => {
  beforeEach(() => {
    _resetForTest();
    mocks.parserInstances.length = 0;
    vi.clearAllMocks();
    mocks.parserInit.mockResolvedValue(undefined);
  });

  // Fixture (0-indexed lines):
  //   0: import os
  //   1: from a.b import c
  //   2:
  //   3: def helper():
  //   4:     return os.getpid()
  //   5:
  //   6: def do_work():
  //   7:     helper()
  //
  // Expected symbols: helper (3-4), do_work (6-7)
  // Expected calls:
  //   getpid @ line 4, enclosingSymbol "helper" (attribute callee os.getpid())
  //   helper @ line 7, enclosingSymbol "do_work" (identifier callee helper())
  // Expected imports:
  //   os  @ line 0 (import_statement)
  //   a.b @ line 1 (import_from_statement module_name)
  function buildPythonModule(): {
    content: string;
    queryMatches: Record<string, Match[]>;
  } {
    const content = [
      "import os",
      "from a.b import c",
      "",
      "def helper():",
      "    return os.getpid()",
      "",
      "def do_work():",
      "    helper()",
    ].join("\n");

    // Symbols
    const helperName = buildNode({
      type: "identifier",
      text: "helper",
      startRow: 3,
    });
    const helperDef = buildNode({
      type: "function_definition",
      startRow: 3,
      endRow: 4,
    });
    const doWorkName = buildNode({
      type: "identifier",
      text: "do_work",
      startRow: 6,
    });
    const doWorkDef = buildNode({
      type: "function_definition",
      startRow: 6,
      endRow: 7,
    });

    // Calls
    const getpidCallee = buildNode({
      type: "identifier",
      text: "getpid",
      startRow: 4,
    });
    const getpidCall = buildNode({ type: "call", startRow: 4, endRow: 4 });
    const helperCallee = buildNode({
      type: "identifier",
      text: "helper",
      startRow: 7,
    });
    const helperCall = buildNode({ type: "call", startRow: 7, endRow: 7 });

    // Imports
    const osSpecifier = buildNode({
      type: "dotted_name",
      text: "os",
      startRow: 0,
    });
    const osStmt = buildNode({
      type: "import_statement",
      startRow: 0,
      endRow: 0,
    });
    const abSpecifier = buildNode({
      type: "dotted_name",
      text: "a.b",
      startRow: 1,
    });
    const abStmt = buildNode({
      type: "import_from_statement",
      startRow: 1,
      endRow: 1,
    });

    const queryMatches: Record<string, Match[]> = {
      ...blankPySymbolMatches(),
      "(function_definition name: (identifier) @name) @node": [
        {
          captures: [
            { name: "name", node: helperName },
            { name: "node", node: helperDef },
          ],
        },
        {
          captures: [
            { name: "name", node: doWorkName },
            { name: "node", node: doWorkDef },
          ],
        },
      ],
      [PY_CALL_QUERY]: [
        {
          captures: [
            { name: "callee", node: getpidCallee },
            { name: "node", node: getpidCall },
          ],
        },
        {
          captures: [
            { name: "callee", node: helperCallee },
            { name: "node", node: helperCall },
          ],
        },
      ],
      [PY_IMPORT_QUERY]: [
        {
          captures: [
            { name: "specifier", node: osSpecifier },
            { name: "node", node: osStmt },
          ],
        },
      ],
      [PY_IMPORT_FROM_QUERY]: [
        {
          captures: [
            { name: "specifier", node: abSpecifier },
            { name: "node", node: abStmt },
          ],
        },
      ],
    };

    return { content, queryMatches };
  }

  function runPythonFixture(fixture: {
    content: string;
    queryMatches: Record<string, Match[]>;
  }) {
    const fakeLang = makeFakeLanguage(fixture.queryMatches);
    // Python is the SECOND grammar loaded (ts first, then py) in the loader.
    mocks.languageLoad
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce(fakeLang);
    makeParserInstance({ rootNode: buildNode({ type: "module" }) }, fakeLang);
    return parseSourceFile("pipeline/data.py", fixture.content);
  }

  it("extracts an identifier call with its enclosing Python function", async () => {
    const result = await runPythonFixture(buildPythonModule());

    expect(result.language).toBe("python");
    expect(result.calls).toBeDefined();

    const helperCall = result.calls!.find((c) => c.callee === "helper");
    expect(helperCall).toBeDefined();
    expect(helperCall!.line).toBe(7);
    expect(helperCall!.enclosingSymbol).toBe("do_work");
  });

  it("extracts an attribute call (os.getpid()) capturing the final attribute as callee", async () => {
    const result = await runPythonFixture(buildPythonModule());

    const getpidCall = result.calls!.find((c) => c.callee === "getpid");
    expect(getpidCall).toBeDefined();
    expect(getpidCall!.line).toBe(4);
    expect(getpidCall!.enclosingSymbol).toBe("helper");
  });

  it("extracts import_statement and import_from_statement specifiers", async () => {
    const result = await runPythonFixture(buildPythonModule());

    expect(result.imports).toBeDefined();
    const specifiers = result.imports!.map((i) => i.specifier);
    expect(specifiers).toContain("os");
    expect(specifiers).toContain("a.b");

    const osImport = result.imports!.find((i) => i.specifier === "os");
    expect(osImport!.line).toBe(0);
    const abImport = result.imports!.find((i) => i.specifier === "a.b");
    expect(abImport!.line).toBe(1);
  });

  it("sets enclosingSymbol = null for a module-level Python call", async () => {
    const calleeNode = buildNode({
      type: "identifier",
      text: "configure",
      startRow: 0,
    });
    const callNode = buildNode({ type: "call", startRow: 0, endRow: 0 });

    const queryMatches: Record<string, Match[]> = {
      ...blankPySymbolMatches(),
      [PY_CALL_QUERY]: [
        {
          captures: [
            { name: "callee", node: calleeNode },
            { name: "node", node: callNode },
          ],
        },
      ],
      [PY_IMPORT_QUERY]: [],
      [PY_IMPORT_FROM_QUERY]: [],
    };

    const result = await runPythonFixture({
      content: "configure()",
      queryMatches,
    });

    const call = result.calls!.find((c) => c.callee === "configure");
    expect(call).toBeDefined();
    expect(call!.enclosingSymbol).toBeNull();
  });
});
