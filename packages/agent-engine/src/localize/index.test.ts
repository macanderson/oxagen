/**
 * Tests for F1 — Deterministic zero-token localization.
 *
 * Coverage targets
 * ─────────────────
 *  • parseTraceback: Python CPython format (Django test runner, pytest, chained exception)
 *  • parseTraceback: Node.js stack trace format
 *  • parseTraceback: stdlib / vendor frame filtering
 *  • extractCandidates (via localize symbol path): backtick, CamelCase, snake_case
 *  • Score fusion + top-5 ranking with a stubbed CodeGraphProvider
 *  • Semantic fallback triggers only when < 3 distinct files from traceback + symbol paths
 *  • renderedBlock character cap (≤ 4000 chars)
 *  • Graceful degradation: null provider returns empty map, never throws
 *  • Graceful degradation: throwing provider returns empty map, never throws
 *  • LocalizationMap shape: files, testHints, tracebackParsed, renderedBlock
 */
import { describe, it, expect, vi } from "vitest";
import { parseTraceback, localize } from "./index";
import type { TracebackFrame, LocalizationMap } from "./index";
import type { CodeGraphProvider } from "../types";

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Django test runner traceback (Python CPython format). */
const DJANGO_TRACEBACK = `
ERROR: test_login (myapp.tests.AuthTests)
----------------------------------------------------------------------
Traceback (most recent call last):
  File "/home/user/project/myapp/tests.py", line 42, in test_login
    response = self.client.post('/login/', data)
  File "/home/user/project/myapp/views.py", line 18, in login_view
    user = authenticate(request, username=username, password=password)
  File "/usr/lib/python3.10/site-packages/django/contrib/auth/__init__.py", line 72, in authenticate
    user = backend.authenticate(request, **credentials)
AttributeError: 'NoneType' object has no attribute 'authenticate'
`;

/** pytest traceback (Python CPython format, with assertion). */
const PYTEST_TRACEBACK = `
FAILED tests/test_utils.py::test_parse_config - AssertionError: assert False
Traceback (most recent call last):
  File "/home/user/project/tests/test_utils.py", line 15, in test_parse_config
    result = parse_config("bad.toml")
  File "/home/user/project/src/utils.py", line 33, in parse_config
    return toml.load(path)
  File "/home/user/project/src/utils.py", line 10, in _load_file
    with open(path) as f:
FileNotFoundError: bad.toml
`;

/** Chained exception traceback (Python 3.x — "During handling of the above exception…"). */
const CHAINED_TRACEBACK = `
Traceback (most recent call last):
  File "/app/core/runner.py", line 55, in run_task
    result = self._execute(task)
  File "/app/core/runner.py", line 88, in _execute
    return handler(task)

During handling of the above exception, another exception occurred:

Traceback (most recent call last):
  File "/app/core/runner.py", line 60, in run_task
    raise TaskError("execution failed") from exc
  File "/usr/lib/python3.10/contextlib.py", line 135, in __exit__
    self.gen.throw(typ, value, traceback)
TaskError: execution failed
`;

/** Node.js stack trace format. */
const NODE_TRACEBACK = `
Error: Cannot read properties of undefined (reading 'map')
    at processItems (src/processor.ts:42:15)
    at runPipeline (src/pipeline/index.ts:88:5)
    at Object.<anonymous> (src/main.ts:10:1)
    at Module._compile (node:internal/modules/cjs/loader:1364:14)
    at Object.Module._extensions..js (node:internal/modules/cjs/loader:1422:10)
`;

// ── parseTraceback: Python formats ────────────────────────────────────────────

describe("parseTraceback — Python CPython format", () => {
  it("parses a Django test runner traceback, innermost first, filtering stdlib", () => {
    const frames = parseTraceback(DJANGO_TRACEBACK);
    // Should have the two project frames (tests.py + views.py); django site-packages filtered
    expect(frames.length).toBeGreaterThanOrEqual(2);
    const files = frames.map((f) => f.file);
    expect(files.some((f) => f.includes("views.py"))).toBe(true);
    expect(files.some((f) => f.includes("tests.py"))).toBe(true);
    // site-packages frame must be filtered
    expect(files.some((f) => f.includes("site-packages"))).toBe(false);
  });

  it("returns frames ordered innermost-first (closest to error origin)", () => {
    const frames = parseTraceback(DJANGO_TRACEBACK);
    // views.py (line 18) is the innermost project frame — should appear before tests.py (line 42)
    const viewsIdx = frames.findIndex((f) => f.file.includes("views.py"));
    const testsIdx = frames.findIndex((f) => f.file.includes("tests.py"));
    expect(viewsIdx).toBeGreaterThanOrEqual(0);
    expect(testsIdx).toBeGreaterThanOrEqual(0);
    expect(viewsIdx).toBeLessThan(testsIdx);
  });

  it("parses a pytest traceback with correct line numbers and symbols", () => {
    const frames = parseTraceback(PYTEST_TRACEBACK);
    const parseConfigFrame = frames.find((f) => f.symbol === "parse_config");
    expect(parseConfigFrame).toBeDefined();
    expect(parseConfigFrame!.line).toBe(33);
    expect(parseConfigFrame!.file).toContain("utils.py");
  });

  it("parses a chained exception traceback, filtering stdlib frames", () => {
    const frames = parseTraceback(CHAINED_TRACEBACK);
    const files = frames.map((f) => f.file);
    // runner.py frames should be present
    expect(files.some((f) => f.includes("runner.py"))).toBe(true);
    // contextlib (stdlib) must be filtered
    expect(files.some((f) => f.includes("contextlib.py"))).toBe(false);
  });

  it("returns an empty array for text with no traceback", () => {
    const frames = parseTraceback(
      "This is just a plain bug description with no stack trace.",
    );
    expect(frames).toHaveLength(0);
  });
});

// ── parseTraceback: Node.js format ────────────────────────────────────────────

describe("parseTraceback — Node.js format", () => {
  it("parses a Node.js stack trace, filtering node: internal frames", () => {
    const frames = parseTraceback(NODE_TRACEBACK);
    const files = frames.map((f) => f.file);
    // Project frames should be present
    expect(files.some((f) => f.includes("processor.ts"))).toBe(true);
    expect(files.some((f) => f.includes("pipeline/index.ts"))).toBe(true);
    // node:internal (node_modules-adjacent) frames must be filtered
    expect(files.some((f) => f.includes("node:internal"))).toBe(false);
  });

  it("extracts correct symbol names from Node.js frames", () => {
    const frames = parseTraceback(NODE_TRACEBACK);
    expect(frames.some((f) => f.symbol === "processItems")).toBe(true);
    expect(frames.some((f) => f.symbol === "runPipeline")).toBe(true);
  });

  it("extracts correct line numbers from Node.js frames", () => {
    const frames = parseTraceback(NODE_TRACEBACK);
    const processorFrame = frames.find((f) => f.file.includes("processor.ts"));
    expect(processorFrame).toBeDefined();
    expect(processorFrame!.line).toBe(42);
  });
});

// ── parseTraceback: stdlib / vendor filtering ──────────────────────────────────

describe("parseTraceback — stdlib / vendor frame filtering", () => {
  it("filters /site-packages/ frames", () => {
    const text = `File "/usr/lib/python3.10/site-packages/requests/api.py", line 73, in get
    return request('get', url, params=params, **kwargs)`;
    const frames = parseTraceback(text);
    expect(frames).toHaveLength(0);
  });

  it("filters /node_modules/ frames", () => {
    const text = `    at Object.<anonymous> (node_modules/express/lib/router/index.js:284:7)`;
    const frames = parseTraceback(text);
    expect(frames).toHaveLength(0);
  });

  it("filters /lib/python frames (stdlib)", () => {
    const text = `  File "/usr/lib/python3.10/contextlib.py", line 135, in __exit__
    self.gen.throw(typ, value, traceback)`;
    const frames = parseTraceback(text);
    expect(frames).toHaveLength(0);
  });

  it("keeps project frames when mixed with vendor frames", () => {
    const text = `
  File "/app/myproject/views.py", line 20, in my_view
    result = helper()
  File "/usr/lib/python3.10/site-packages/django/http/response.py", line 500, in content
    self.tell()
`;
    const frames = parseTraceback(text);
    expect(frames.some((f) => f.file.includes("views.py"))).toBe(true);
    expect(frames.some((f) => f.file.includes("site-packages"))).toBe(false);
  });
});

// ── TracebackFrame shape ──────────────────────────────────────────────────────

describe("TracebackFrame shape", () => {
  it("each frame has file, line (number), and symbol properties", () => {
    const frames = parseTraceback(PYTEST_TRACEBACK);
    for (const f of frames) {
      expect(typeof f.file).toBe("string");
      expect(typeof f.line).toBe("number");
      expect(typeof f.symbol).toBe("string");
      expect(f.file.length).toBeGreaterThan(0);
      expect(f.line).toBeGreaterThan(0);
    }
  });
});

// ── Helpers: stubbed CodeGraphProvider ───────────────────────────────────────

/**
 * Build a stub CodeGraphProvider whose responses are fully scripted.
 * `responses` maps "operation:query" → result string.
 * Unmatched queries return "".
 */
function makeStubGraph(
  responses: Record<string, string>,
  opts?: { throwOnQuery?: boolean },
): CodeGraphProvider {
  return {
    query: vi.fn(
      async (
        operation: string,
        query: string,
        _limit?: number,
      ): Promise<string> => {
        if (opts?.throwOnQuery) throw new Error("graph unavailable");
        const key = `${operation}:${query}`;
        return responses[key] ?? "";
      },
    ),
  };
}

// ── localize: graceful degradation ───────────────────────────────────────────

describe("localize — graceful degradation", () => {
  it("returns empty map when graph is null, never throws", async () => {
    const result = await localize("some issue text", null);
    expect(result.files).toHaveLength(0);
    expect(result.testHints).toHaveLength(0);
    expect(result.tracebackParsed).toBe(false);
    expect(result.renderedBlock).toBe("");
  });

  it("returns empty map when graph is undefined, never throws", async () => {
    const result = await localize("some issue text", undefined);
    expect(result.files).toHaveLength(0);
    expect(result.renderedBlock).toBe("");
  });

  it("returns empty map when graph.query always throws, never throws from localize()", async () => {
    const graph = makeStubGraph({}, { throwOnQuery: true });
    const result = await localize("some issue text", graph);
    expect(result.files).toHaveLength(0);
    expect(result.renderedBlock).toBe("");
  });

  it("never throws even when issue text is empty", async () => {
    const result = await localize("", null);
    expect(result.files).toHaveLength(0);
  });
});

// ── localize: symbol path ─────────────────────────────────────────────────────

describe("localize — symbol path (extractCandidates)", () => {
  it("resolves backtick-quoted symbols via graph search", async () => {
    const graph = makeStubGraph({
      "search:MyValidator": [
        "function validate — packages/validators/src/my_validator.py:10  def validate(self, value):",
      ].join("\n"),
    });

    const result = await localize(
      "The `MyValidator` class raises an error when value is None.",
      graph,
    );

    expect(result.files.some((f) => f.path.includes("my_validator"))).toBe(
      true,
    );
    const hit = result.files.find((f) => f.path.includes("my_validator"))!;
    expect(hit.score).toBeGreaterThan(0);
    expect(hit.reason).toContain("MyValidator");
  });

  it("resolves snake_case tokens from issue text", async () => {
    const graph = makeStubGraph({
      "search:parse_config": [
        "function parse_config — packages/config/src/parser.py:33  def parse_config(path):",
      ].join("\n"),
    });

    const result = await localize(
      "The parse_config function fails when the file is missing.",
      graph,
    );

    expect(result.files.some((f) => f.path.includes("parser.py"))).toBe(true);
  });

  it("resolves CamelCase tokens from issue text", async () => {
    const graph = makeStubGraph({
      "search:FormRenderer": [
        "class FormRenderer — packages/forms/src/renderer.ts:5  export class FormRenderer {",
      ].join("\n"),
    });

    const result = await localize(
      "FormRenderer does not handle empty field lists correctly.",
      graph,
    );

    expect(result.files.some((f) => f.path.includes("renderer.ts"))).toBe(true);
  });
});

// ── localize: traceback path ──────────────────────────────────────────────────

describe("localize — traceback path", () => {
  it("sets tracebackParsed = true when frames are found in issue text", async () => {
    const graph = makeStubGraph({
      "search:login_view": [
        "function login_view — myapp/views.py:18  def login_view(request):",
      ].join("\n"),
      "file_symbols:/home/user/project/myapp/views.py": [
        "function login_view — myapp/views.py:18  def login_view(request):",
      ].join("\n"),
      "file_symbols:/home/user/project/myapp/tests.py": [
        "function test_login — myapp/tests.py:42  def test_login(self):",
      ].join("\n"),
    });

    const result = await localize(DJANGO_TRACEBACK, graph);
    expect(result.tracebackParsed).toBe(true);
  });

  it("sets tracebackParsed = false when issue has no traceback", async () => {
    const graph = makeStubGraph({});
    const result = await localize("The login button is broken.", graph);
    expect(result.tracebackParsed).toBe(false);
  });

  it("traceback-hit files score higher than pure symbol matches", async () => {
    const tracebackIssue = `
Traceback (most recent call last):
  File "/app/core/engine.py", line 100, in run
    result = process()
  File "/app/core/engine.py", line 50, in process
    return SomeHelper.compute()

Some other text mentioning HelperClass.
`;

    const graph = makeStubGraph({
      "search:run": "function run — app/core/engine.py:100  def run(self):",
      "search:process":
        "function process — app/core/engine.py:50  def process(self):",
      "file_symbols:/app/core/engine.py":
        "function run — app/core/engine.py:100  def run(self):",
      "search:SomeHelper":
        "class SomeHelper — app/helpers/helper.py:5  class SomeHelper:",
      "search:HelperClass":
        "class HelperClass — app/helpers/other.py:3  class HelperClass:",
    });

    const result = await localize(tracebackIssue, graph);
    const engineEntry = result.files.find((f) => f.path.includes("engine.py"));
    const helperEntry = result.files.find((f) => f.path.includes("other.py"));

    expect(engineEntry).toBeDefined();
    if (engineEntry && helperEntry) {
      expect(engineEntry.score).toBeGreaterThan(helperEntry.score);
    }
  });
});

// ── localize: semantic fallback ───────────────────────────────────────────────

describe("localize — semantic fallback", () => {
  it("triggers semantic_search when fewer than 3 distinct files found", async () => {
    const querySpy = vi.fn(async (op: string, _q: string, _l?: number) => {
      if (op === "semantic_search") {
        return "packages/auth/src/login.py\npackages/auth/src/session.py";
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    const result = await localize(
      "Login fails intermittently on mobile devices.",
      graph,
    );

    expect(querySpy).toHaveBeenCalledWith(
      "semantic_search",
      expect.any(String),
      5,
    );
    // Semantic results should appear in files
    expect(
      result.files.some(
        (f) => f.path.includes("login.py") || f.path.includes("session.py"),
      ),
    ).toBe(true);
  });

  it("does NOT trigger semantic_search when 3 or more distinct files are already found", async () => {
    // Return 3 different files from symbol queries
    const querySpy = vi.fn(async (op: string, q: string, _l?: number) => {
      if (op === "search") {
        if (q === "FooClass")
          return "class FooClass — src/foo.py:1  class FooClass:";
        if (q === "BarClass")
          return "class BarClass — src/bar.py:1  class BarClass:";
        if (q === "BazClass")
          return "class BazClass — src/baz.py:1  class BazClass:";
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    await localize("FooClass, BarClass, and BazClass all have bugs.", graph);

    const semanticCalls = (
      querySpy.mock.calls as Array<[string, string, number?]>
    ).filter(([op]) => op === "semantic_search");
    expect(semanticCalls).toHaveLength(0);
  });
});

// ── localize: score fusion + top-5 ranking ────────────────────────────────────

describe("localize — score fusion and top-5 ranking", () => {
  it("returns at most 5 files", async () => {
    // Stub that returns a different file for each of many symbol queries
    const querySpy = vi.fn(async (op: string, q: string) => {
      if (op === "search") {
        return `function ${q} — src/${q}.py:1  def ${q}():`;
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    // Issue with many symbols
    const issue =
      "FooClass, BarClass, BazClass, QuxClass, QuuxClass, CorgeClass, GraultClass all fail.";
    const result = await localize(issue, graph);
    expect(result.files.length).toBeLessThanOrEqual(5);
  });

  it("applies score weights: traceback (3) > symbol (2) > semantic (1) > dependents (0.5)", async () => {
    // File A: traceback hit only → score = 3
    // File B: symbol hit only → score = 2
    // File C: semantic hit only → score = 1
    // We need < 3 files from A+B to trigger semantic; use only A+B from traceback+symbol.
    const issue = `
The TracedFunc function fails.

Traceback (most recent call last):
  File "/app/traced.py", line 10, in traced_func
    do_something()
`;

    const querySpy = vi.fn(async (op: string, q: string, _l?: number) => {
      if (op === "search" && q === "traced_func") {
        return "function traced_func — app/traced.py:10  def traced_func():";
      }
      if (op === "search" && q === "TracedFunc") {
        return "class TracedFunc — app/traced_class.py:1  class TracedFunc:";
      }
      if (op === "file_symbols" && q.includes("traced.py")) {
        return "function traced_func — app/traced.py:10  def traced_func():";
      }
      if (op === "semantic_search") {
        return "app/semantic_only.py";
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    const result = await localize(issue, graph);

    const traceFile = result.files.find((f) => f.path === "app/traced.py");
    const symFile = result.files.find((f) => f.path === "app/traced_class.py");
    const semFile = result.files.find((f) => f.path === "app/semantic_only.py");

    // traced.py should have the highest score (traceback hit)
    if (traceFile && symFile) {
      expect(traceFile.score).toBeGreaterThan(symFile.score);
    }
    if (symFile && semFile) {
      expect(symFile.score).toBeGreaterThan(semFile.score);
    }
  });

  it("files are sorted by descending score", async () => {
    const querySpy = vi.fn(async (op: string, q: string) => {
      if (op === "search") {
        return `function ${q} — src/${q}.py:1  def ${q}():`;
      }
      return "";
    });
    const graph: CodeGraphProvider = { query: querySpy };
    const result = await localize(
      "`alpha_func` and `beta_func` are broken.",
      graph,
    );

    for (let i = 1; i < result.files.length; i++) {
      expect(result.files[i - 1]!.score).toBeGreaterThanOrEqual(
        result.files[i]!.score,
      );
    }
  });

  it("each file entry has path, symbols, score, and reason fields", async () => {
    const graph = makeStubGraph({
      "search:MyClass": "class MyClass — src/my_class.py:1  class MyClass:",
    });
    const result = await localize("`MyClass` raises an error.", graph);

    for (const f of result.files) {
      expect(typeof f.path).toBe("string");
      expect(Array.isArray(f.symbols)).toBe(true);
      expect(typeof f.score).toBe("number");
      expect(typeof f.reason).toBe("string");
    }
  });
});

// ── localize: renderedBlock ───────────────────────────────────────────────────

describe("localize — renderedBlock", () => {
  it("renderedBlock is empty when no files are found", async () => {
    const graph = makeStubGraph({});
    const result = await localize("some issue", graph);
    expect(result.renderedBlock).toBe("");
  });

  it("renderedBlock contains the section header when files are found", async () => {
    const graph = makeStubGraph({
      "search:MyClass": "class MyClass — src/my_class.py:1  class MyClass:",
    });
    const result = await localize("`MyClass` is broken.", graph);
    if (result.files.length > 0) {
      expect(result.renderedBlock).toContain(
        "## Candidate locations (deterministic)",
      );
    }
  });

  it("renderedBlock lists candidate file paths", async () => {
    const graph = makeStubGraph({
      "search:MyClass": "class MyClass — src/my_class.py:1  class MyClass:",
    });
    const result = await localize("`MyClass` is broken.", graph);
    if (result.files.length > 0) {
      expect(result.renderedBlock).toContain("my_class.py");
    }
  });

  it("renderedBlock stays within the 4000-char cap", async () => {
    // Generate a graph that returns many files with long paths and symbols
    const querySpy = vi.fn(async (op: string, q: string) => {
      if (op === "search") {
        // Return a very long result
        const longPath = `packages/very/long/path/to/some/deeply/nested/${q}.py`;
        return Array.from(
          { length: 20 },
          (_, i) =>
            `function ${q}_method_${i} — ${longPath}:${i + 1}  def ${q}_method_${i}(self, arg1, arg2, arg3):`,
        ).join("\n");
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    // Issue with many symbols to generate lots of content
    const issue = [
      "`VeryLongClassName` and `AnotherLongClass` and `ThirdClass` are all broken.",
      "Also `FourthClass` and `FifthClass` need fixing.",
    ].join(" ");

    const result = await localize(issue, graph);
    expect(result.renderedBlock.length).toBeLessThanOrEqual(4000);
  });

  it("renderedBlock includes test hint information", async () => {
    const graph = makeStubGraph({
      "search:MyClass":
        "class MyClass — packages/mylib/src/my_class.py:1  class MyClass:",
    });
    const result = await localize("`MyClass` is broken.", graph);
    if (result.files.length > 0) {
      // testHints should reference the package's test directory
      expect(result.testHints.length).toBeGreaterThan(0);
    }
  });
});

// ── localize: LocalizationMap shape ──────────────────────────────────────────

describe("localize — LocalizationMap shape", () => {
  it("returns all required fields with correct types", async () => {
    const graph = makeStubGraph({
      "search:SomeClass": "class SomeClass — src/some.py:1  class SomeClass:",
    });
    const result: LocalizationMap = await localize("`SomeClass` fails.", graph);

    expect(Array.isArray(result.files)).toBe(true);
    expect(Array.isArray(result.testHints)).toBe(true);
    expect(typeof result.tracebackParsed).toBe("boolean");
    expect(typeof result.renderedBlock).toBe("string");
  });

  it("testHints are derived from the top-ranked file paths", async () => {
    const graph = makeStubGraph({
      "search:MyClass":
        "class MyClass — packages/mylib/src/my_class.py:1  class MyClass:",
    });
    const result = await localize("`MyClass` is broken.", graph);
    if (result.files.length > 0) {
      // testHints should include something related to the package root
      const allHints = result.testHints.join(" ");
      expect(allHints.length).toBeGreaterThan(0);
    }
  });
});

// ── localize: dependents centrality ──────────────────────────────────────────

describe("localize — dependents centrality scoring", () => {
  it("files that are dependents of traceback hits get a dependents_centrality bonus", async () => {
    const issue = `
Traceback (most recent call last):
  File "/app/core/base.py", line 5, in base_func
    do_work()
`;

    const querySpy = vi.fn(async (op: string, q: string) => {
      if (op === "search" && q === "base_func") {
        return "function base_func — app/core/base.py:5  def base_func():";
      }
      if (op === "file_symbols" && q.includes("base.py")) {
        return "function base_func — app/core/base.py:5  def base_func():";
      }
      if (op === "dependents" && q === "app/core/base.py") {
        return "app/core/consumer.py";
      }
      return "";
    });

    const graph: CodeGraphProvider = { query: querySpy };
    const result = await localize(issue, graph);

    const consumerEntry = result.files.find(
      (f) => f.path === "app/core/consumer.py",
    );
    expect(consumerEntry).toBeDefined();
    if (consumerEntry) {
      expect(consumerEntry.score).toBeGreaterThan(0);
    }
  });
});

// ── localize: timeout budget ──────────────────────────────────────────────────

describe("localize — timeout budget (ENHANCE races the stage budget)", () => {
  it("returns within the budget when the graph hangs, instead of blocking the caller", async () => {
    // A provider whose queries never resolve — the cold-store worst case.
    const hung: CodeGraphProvider = {
      query: () => new Promise<string>(() => {}),
    };

    const started = Date.now();
    const result = await localize("fix `alpha` in the parser", hung, {
      timeoutMs: 30,
    });
    const elapsed = Date.now() - started;

    // Bounded: one 30 ms race, not an indefinite hang (generous CI cushion).
    expect(elapsed).toBeLessThan(2_000);
    expect(result.files).toEqual([]);
    expect(result.renderedBlock).toBe("");
  });

  it("short-circuits remaining queries after the deadline without touching the provider", async () => {
    const querySpy = vi.fn(() => new Promise<string>(() => {}));
    const graph: CodeGraphProvider = { query: querySpy };

    // Four backticked symbols → four symbol-path lookups. Queries run
    // sequentially, so the first one consumes the whole 25 ms budget and the
    // remaining three must be skipped before ever reaching the provider.
    await localize("wire `alpha` `beta` `gamma` `delta`", graph, {
      timeoutMs: 25,
    });

    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it("treats an over-max-timer budget (e.g. MAX_SAFE_INTEGER from an unbounded ENHANCE) as no deadline", async () => {
    const graph: CodeGraphProvider = {
      query: vi.fn(async (op: string, q: string) =>
        op === "search" && q === "alpha"
          ? "function alpha — src/alpha.ts:3  export function alpha()"
          : "",
      ),
    };

    const result = await localize("fix `alpha`", graph, {
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(result.files.map((f) => f.path)).toContain("src/alpha.ts");
  });

  it("still never throws when the deadline expires mid-pass", async () => {
    let call = 0;
    const graph: CodeGraphProvider = {
      query: () => {
        call += 1;
        // First query resolves fast with a hit; second hangs past the deadline.
        if (call === 1) {
          return Promise.resolve(
            "function beta — src/beta.ts:7  export function beta()",
          );
        }
        return new Promise<string>(() => {});
      },
    };

    const result = await localize("fix `beta` and `gamma`", graph, {
      timeoutMs: 40,
    });

    // The pre-deadline hit is kept — partial results beat an empty map.
    expect(result.files.map((f) => f.path)).toContain("src/beta.ts");
  });
});
