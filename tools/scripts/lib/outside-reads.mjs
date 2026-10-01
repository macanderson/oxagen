#!/usr/bin/env node
/**
 * Find the files a tools/scripts test reads from outside its package, so a
 * guard can fail the ones turbo would replay from a stale cache (#4664 item 2).
 *
 * Turbo hashes `@oxagen/scripts#test:unit` and `#test:coverage` over this
 * package's own files. A test that reads a file outside the package keeps
 * its cache key when that file changes, and `main` replays a pass the test
 * did not earn. Each such read must be one of two things:
 *
 *   - a declared input: a `$TURBO_ROOT$/...` glob in tools/scripts/turbo.json,
 *     under both test tasks, so a change to the file re-runs the test, or
 *   - in a `*.tree.test.ts` file, which vitest.config.ts leaves out of the
 *     turbo tasks and `pnpm check:tree-guards` runs uncached in the checks
 *     job.
 *
 * ## How it reads a test
 *
 * It parses the test with the TypeScript parser and folds the path
 * expressions it can evaluate: `import.meta.url`, `import.meta.dirname`,
 * `__dirname`, `fileURLToPath`, `dirname`, `join`, `resolve`, `new URL`,
 * `.pathname`, template strings, and `+`, through `const` bindings and the
 * constants the package's own modules export. A path that leaves the package
 * counts as read where the test hands it to anything other than another path
 * builder: a call such as `readFileSync(...)` or `check(repoRoot)`, an object
 * property such as `{ cwd: repoRoot }`, an array, or a return.
 *
 * A helper such as `read = (path) => readFileSync(join(ROOT, path))` is
 * evaluated once per call, with that call's arguments. A call to a function
 * the package exports reads the path defaults of the parameters it leaves
 * out, so `findGaps()` reads the root `findGaps({ root = REPO_ROOT } = {})`
 * defaults to. A path built from a value it cannot fold, such as
 * `join(repoRoot, name)` inside a loop, counts as a read of everything under
 * the part it knows, here the whole repository.
 *
 * It also reads every module import, static or dynamic, and `vi.mock`, and
 * follows the imports of the package's own modules, with the paths those
 * modules read at the top level when imported. So a test that imports a
 * script which imports `../../packages/x/src/y.ts` reads that file too.
 *
 * ## What it cannot see
 *
 * A path a function the test calls builds inside its own body from a module
 * constant, rather than from a parameter default: `run()` that reads
 * `join(REPO_ROOT, "infra")` in its body passes this scan. A child process
 * that reads the repository from its own code is invisible too. Put such a
 * test in a `*.tree.test.ts` file; review has to catch it. The scan fails
 * closed everywhere else: a path it cannot resolve counts as a read of the
 * whole part it can.
 *
 * Usage: node tools/scripts/lib/outside-reads.mjs [--all]
 *   Prints each cached test's undeclared outside reads (with `--all`, every
 *   test's outside reads), and exits 1 when a cached test has one.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { isEntrypoint } from "./is-entrypoint.mjs";

/** The package this scan guards: tools/scripts. */
export const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A test the checks job runs uncached, and turbo never runs. */
export const TREE_TEST = /\.tree\.test\.ts$/;

/**
 * Calls whose path argument builds another value, or compares one, rather
 * than reading a file. A path handed to any other call is read.
 */
const BUILDERS = new Set([
  "join",
  "resolve",
  "dirname",
  "basename",
  "extname",
  "normalize",
  "relative",
  "fileURLToPath",
  "pathToFileURL",
  "String",
  "startsWith",
  "endsWith",
  "includes",
  "indexOf",
  "replace",
  "replaceAll",
  "slice",
  "split",
  "concat",
  "toString",
  "expect",
  "toBe",
  "toEqual",
  "toStrictEqual",
  "toContain",
  "toMatch",
]);

/** Calls whose first argument is a module specifier. */
const MODULE_CALLS = new Set(["mock", "doMock", "importActual", "importMock"]);

/** How many call sites deep a helper's argument is followed. */
const MAX_DEPTH = 3;

/** How many argument combinations one helper call evaluates. */
const MAX_COMBINATIONS = 64;

/**
 * @typedef {{ kind: "path", abs: string, exact: boolean }
 *   | { kind: "url", abs: string, dir: boolean, exact: boolean }
 *   | { kind: "str", value: string }} Value
 *
 * A path or URL, with `exact` false when only a prefix of it is known, or a
 * string.
 */

/**
 * @typedef {{ path: string, exact: boolean, line: number, via: string }} Read
 *
 * One read outside the package. `path` is relative to the repository root,
 * with `/` separators. When `exact` is false the read is somewhere under
 * `path`. `via` names the package module that made it, when the test did
 * not.
 */

function toPosix(p) {
  return p.split(sep).join("/");
}

function isInside(abs, dir) {
  const rel = relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

function calleeName(expr) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return null;
}

function stringOf(value) {
  return value?.kind === "str" ? value.value : null;
}

function isPathLike(value) {
  return value?.kind === "path" || value?.kind === "url";
}

/** Strip the wrappers that do not change a value: parentheses, `as`, `!`. */
function unwrap(node) {
  let n = node;
  while (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isSatisfiesExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isAwaitExpression(n)
  ) {
    n = n.expression;
  }
  return n;
}

function isFunctionLike(node) {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node)
  );
}

/** The name a function is called by: its declaration name or its `const`. */
function functionName(fn) {
  if (ts.isFunctionDeclaration(fn) && fn.name) return fn.name.text;
  const parent = fn.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/**
 * Fold `join(base, ...rest)` or `resolve(base, ...rest)`. A value it cannot
 * fold ends the fold, and the result keeps what was known before it.
 */
function joinValues(base, rest) {
  let abs = base.abs;
  for (const value of rest) {
    if (value?.kind === "str") {
      abs = join(abs, value.value);
    } else if (isPathLike(value)) {
      abs = value.abs;
      if (!value.exact) return { kind: "path", abs: normalize(abs), exact: false };
    } else {
      return { kind: "path", abs: normalize(abs), exact: false };
    }
  }
  return { kind: "path", abs: normalize(abs), exact: base.exact };
}

/** The directory a URL resolves relative references against. */
function urlBase(url) {
  return url.dir ? url.abs : dirname(url.abs);
}

/** Whether a path names a file on disk. */
function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/** The file a relative specifier names, trying the extensions TS allows. */
function resolveModule(fromFile, specifier, exists = isFile) {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    base.replace(/\.mjs$/, ".mts"),
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.mjs"),
  ];
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return base;
}

/** A module specifier's text, from an import, an export, or a call. */
function specifierOf(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    const typeOnly = ts.isImportDeclaration(node)
      ? node.importClause?.isTypeOnly === true
      : node.isTypeOnly;
    return typeOnly ? null : node.moduleSpecifier.text;
  }
  if (ts.isCallExpression(node) && node.arguments.length > 0) {
    const first = node.arguments[0];
    const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
    const name = calleeName(node.expression);
    if ((isImport || (name && MODULE_CALLS.has(name))) && ts.isStringLiteralLike(first)) {
      return first.text;
    }
  }
  return null;
}

/**
 * Whether the value of `node` is handed on, rather than built into another
 * path or compared with one.
 */
function isUse(node) {
  let child = node;
  let parent = node.parent;
  while (
    parent &&
    (ts.isParenthesizedExpression(parent) ||
      ts.isAsExpression(parent) ||
      ts.isNonNullExpression(parent) ||
      ts.isSatisfiesExpression(parent) ||
      ts.isAwaitExpression(parent))
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return false;
  if (ts.isCallExpression(parent)) {
    if (parent.expression === child) return false;
    const name = calleeName(parent.expression);
    return !(name && BUILDERS.has(name));
  }
  if (ts.isNewExpression(parent)) return calleeName(parent.expression) !== "URL";
  if (ts.isPropertyAssignment(parent)) return parent.initializer === child;
  return (
    ts.isShorthandPropertyAssignment(parent) ||
    ts.isSpreadAssignment(parent) ||
    ts.isSpreadElement(parent) ||
    ts.isArrayLiteralExpression(parent) ||
    ts.isReturnStatement(parent) ||
    (ts.isArrowFunction(parent) && parent.body === child)
  );
}

const ENTRYPOINT_TEST = /\bisEntrypoint\s*\(|process\.argv\[1\]|import\.meta\.main\b/;

/**
 * Whether `node` sits in a block only a direct start runs: an `if` whose
 * condition calls `isEntrypoint`, compares `import.meta.url` with argv, or
 * names a `const` that does. Vitest imports a script and never starts it, so
 * the block never runs.
 *
 * @param {ts.Node} node
 * @param {Map<string, any>} bindings the module's `const` bindings
 */
function inEntrypointBlock(node, bindings) {
  for (let n = node.parent; n; n = n.parent) {
    if (!ts.isIfStatement(n)) continue;
    if (ENTRYPOINT_TEST.test(n.expression.getText())) return true;
    const cond = unwrap(n.expression);
    if (ts.isIdentifier(cond)) {
      const binding = bindings.get(cond.text);
      if (binding?.kind === "expr" && ENTRYPOINT_TEST.test(binding.node.getText())) return true;
    }
  }
  return false;
}

/** Whether `node` runs at import time: outside every function body. */
function atTopLevel(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (isFunctionLike(n)) return false;
  }
  return true;
}

/** Whether `node` mentions any of `names` as an identifier. */
function references(node, names) {
  let found = false;
  const look = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && names.has(n.text)) found = true;
    else ts.forEachChild(n, look);
  };
  look(node);
  return found;
}

/** Whether `node` is what its function returns. */
function isReturned(node) {
  let child = node;
  let parent = node.parent;
  while (parent && (ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent))) {
    child = parent;
    parent = parent.parent;
  }
  return (
    !!parent &&
    (ts.isReturnStatement(parent) || (ts.isArrowFunction(parent) && parent.body === child))
  );
}

/**
 * Whether a function reads from its parameter `name`: hands it, or a local
 * built from it, to a call, an object, or an array. A function that only
 * builds a path from it and returns that path reads nothing; its caller
 * decides.
 */
function readsParam(fn, name) {
  if (!fn.body) return false;
  const derived = new Set([name]);
  for (let round = 0; round < 5; round++) {
    let grew = false;
    const collect = (n) => {
      if (
        ts.isVariableDeclaration(n) &&
        ts.isIdentifier(n.name) &&
        n.initializer &&
        !derived.has(n.name.text) &&
        references(n.initializer, derived)
      ) {
        derived.add(n.name.text);
        grew = true;
      }
      ts.forEachChild(n, collect);
    };
    collect(fn.body);
    if (!grew) break;
  }
  let read = false;
  const look = (n) => {
    if (read) return;
    if (ts.isExpression(n) && isUse(n) && !isReturned(n) && references(n, derived)) {
      read = true;
      return;
    }
    ts.forEachChild(n, look);
  };
  look(fn.body);
  return read;
}

/**
 * Parse and index the package's sources on demand.
 *
 * @param {{
 *   packageDir: string,
 *   read: (file: string) => string,
 *   exists: (file: string) => boolean,
 * }} options
 */
function createProject({ packageDir, read, exists }) {
  /** @type {Map<string, any>} */
  const files = new Map();

  function load(file) {
    if (files.has(file)) return files.get(file);
    const text = exists(file) ? read(file) : "";
    const kind = /\.m?js$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const bindings = new Map();
    const functions = new Map();
    const calls = new Map();
    const bind = (name, value) => {
      bindings.set(name, bindings.has(name) ? null : value);
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bind(node.name.text, { kind: "expr", node: node.initializer });
        const init = unwrap(node.initializer);
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          functions.set(node.name.text, init);
        }
      }
      if (ts.isFunctionDeclaration(node) && node.name) functions.set(node.name.text, node);
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text.startsWith(".") &&
        node.importClause
      ) {
        const target = resolveModule(file, node.moduleSpecifier.text, exists);
        if (isInside(target, packageDir)) {
          const clause = node.importClause;
          if (clause.name) bind(clause.name.text, { kind: "import", file: target, name: "default" });
          const named = clause.namedBindings;
          if (named && ts.isNamedImports(named)) {
            for (const el of named.elements) {
              bind(el.name.text, {
                kind: "import",
                file: target,
                name: (el.propertyName ?? el.name).text,
              });
            }
          } else if (named && ts.isNamespaceImport(named)) {
            bind(named.name.text, { kind: "namespace", file: target });
          }
        }
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const list = calls.get(node.expression.text) ?? [];
        list.push(node);
        calls.set(node.expression.text, list);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    const entry = { file, source, bindings, functions, calls, memo: new Map() };
    files.set(file, entry);
    return entry;
  }

  /** The value a package module exports under `name`, or null. */
  function exported(file, name, depth) {
    const mod = load(file);
    const binding = mod.bindings.get(name);
    if (!binding || depth > MAX_DEPTH + 2) return null;
    return bindingValue(mod, binding, new Map(), depth + 1);
  }

  /** The function a package module exports under `name`, with its module. */
  function exportedFunction(file, name) {
    const mod = load(file);
    const fn = mod.functions.get(name);
    return fn ? { mod, fn } : null;
  }

  function bindingValue(mod, binding, scope, depth) {
    if (binding.kind === "expr") return evaluate(mod, binding.node, scope, depth);
    if (binding.kind === "import") return exported(binding.file, binding.name, depth);
    return null;
  }

  /**
   * The value of `raw` in `mod`, with `scope` naming the parameters a call
   * bound, or null when it cannot be folded.
   *
   * @returns {Value | null}
   */
  let stack = 0;

  function evaluate(mod, raw, scope = new Map(), depth = 0) {
    const node = unwrap(raw);
    const cacheable = scope.size === 0;
    if (cacheable && mod.memo.has(node)) return mod.memo.get(node);
    // A binding that refers back to itself under a call's scope would
    // recurse without end. No real path needs this many steps.
    if (stack > 200) return null;
    if (cacheable) mod.memo.set(node, null);
    stack += 1;
    const value = compute(mod, node, scope, depth);
    stack -= 1;
    if (cacheable) mod.memo.set(node, value);
    return value;
  }

  function compute(mod, node, scope, depth) {
    const file = mod.file;
    const ev = (n) => evaluate(mod, n, scope, depth);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return { kind: "str", value: node.text };
    }
    if (ts.isIdentifier(node)) {
      if (scope.has(node.text)) return scope.get(node.text);
      if (node.text === "__dirname") return { kind: "path", abs: dirname(file), exact: true };
      const binding = mod.bindings.get(node.text);
      return binding ? bindingValue(mod, binding, scope, depth) : null;
    }
    if (ts.isPropertyAccessExpression(node)) {
      const target = unwrap(node.expression);
      if (ts.isMetaProperty(target)) {
        if (node.name.text === "url") return { kind: "url", abs: file, dir: false, exact: true };
        if (node.name.text === "dirname") return { kind: "path", abs: dirname(file), exact: true };
        if (node.name.text === "filename") return { kind: "path", abs: file, exact: true };
        return null;
      }
      if (ts.isIdentifier(target)) {
        const binding = mod.bindings.get(target.text);
        if (binding?.kind === "namespace") return exported(binding.file, node.name.text, depth);
      }
      if (node.name.text === "pathname" || node.name.text === "href") {
        const url = ev(target);
        if (url?.kind === "url") return { kind: "path", abs: url.abs, exact: url.exact };
      }
      return null;
    }
    if (ts.isTemplateExpression(node)) {
      let value = node.head.text ? { kind: "str", value: node.head.text } : null;
      for (const span of node.templateSpans) {
        const part = ev(span.expression);
        if (value === null) {
          if (isPathLike(part)) value = { kind: "path", abs: part.abs, exact: part.exact };
          else if (part?.kind === "str") value = part;
          else return null;
        } else if (value.kind === "str") {
          const text = stringOf(part);
          if (text === null) return null;
          value = { kind: "str", value: value.value + text };
        } else {
          const text = stringOf(part);
          if (text === null || !value.exact) {
            return { kind: "path", abs: normalize(value.abs), exact: false };
          }
          value = { kind: "path", abs: value.abs + text, exact: true };
        }
        value =
          value.kind === "path"
            ? { kind: "path", abs: value.abs + span.literal.text, exact: value.exact }
            : { kind: "str", value: value.value + span.literal.text };
      }
      if (value?.kind === "path") value = { ...value, abs: normalize(value.abs) };
      return value;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = ev(node.left);
      const right = ev(node.right);
      if (left?.kind === "str" && right?.kind === "str") {
        return { kind: "str", value: left.value + right.value };
      }
      if (isPathLike(left)) {
        const text = stringOf(right);
        if (text === null || !left.exact) return { kind: "path", abs: normalize(left.abs), exact: false };
        return { kind: "path", abs: normalize(left.abs + text), exact: true };
      }
      return null;
    }
    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken)
    ) {
      // `options.root ?? REPO_ROOT`: the fallback is what a test that passes
      // nothing reads.
      return ev(node.right);
    }
    if (ts.isNewExpression(node)) {
      if (calleeName(node.expression) !== "URL") return null;
      const [ref, baseNode] = node.arguments ?? [];
      if (!ref || !baseNode) return null;
      const base = ev(baseNode);
      if (base?.kind !== "url") return null;
      const text = stringOf(ev(ref));
      if (text === null) return { kind: "url", abs: urlBase(base), dir: true, exact: false };
      return {
        kind: "url",
        abs: normalize(join(urlBase(base), text)),
        dir: text.endsWith("/") || text === "." || text === "..",
        exact: base.exact,
      };
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const args = node.arguments.map((a) => ev(a));
      if (name === "fileURLToPath") {
        const url = args[0];
        if (url?.kind === "url") return { kind: "path", abs: url.abs, exact: url.exact };
        return url?.kind === "path" ? url : null;
      }
      if (name === "pathToFileURL") {
        const p = args[0];
        return p?.kind === "path" ? { kind: "url", abs: p.abs, dir: false, exact: p.exact } : null;
      }
      if (name === "dirname") {
        const p = args[0];
        return isPathLike(p) ? { kind: "path", abs: dirname(p.abs), exact: p.exact } : null;
      }
      if (name === "realpathSync") return args[0]?.kind === "path" ? args[0] : null;
      if (name === "join" || name === "resolve") {
        const [base, ...rest] = args;
        if (isPathLike(base)) {
          return joinValues({ kind: "path", abs: base.abs, exact: base.exact }, rest);
        }
        // `join("packages", "x", "y.ts")` is a relative path, still a string.
        // `resolve` of strings depends on the process's directory, so it
        // stays unknown.
        if (name === "join" && args.length > 0 && args.every((a) => a?.kind === "str")) {
          return { kind: "str", value: toPosix(join(...args.map((a) => a.value))) };
        }
        return null;
      }
      return null;
    }
    return null;
  }

  /**
   * The nearest `for (const x of [...])` around `node` whose variable it
   * uses, with the value of each element, when the loop walks an array
   * literal or a `const` bound to one.
   */
  function loopAround(mod, node) {
    for (let n = node.parent; n; n = n.parent) {
      if (isFunctionLike(n)) return null;
      if (!ts.isForOfStatement(n) || !ts.isVariableDeclarationList(n.initializer)) continue;
      const [decl] = n.initializer.declarations;
      if (!decl || !ts.isIdentifier(decl.name)) continue;
      const name = decl.name.text;
      if (!references(node, new Set([name]))) continue;
      let list = unwrap(n.expression);
      if (ts.isIdentifier(list)) {
        const binding = mod.bindings.get(list.text);
        list = binding?.kind === "expr" ? unwrap(binding.node) : list;
      }
      if (!ts.isArrayLiteralExpression(list)) return null;
      return { name, values: list.elements.map((e) => evaluate(mod, e)) };
    }
    return null;
  }

  /** The nearest named function around `node` whose parameter it uses. */
  function helperAround(mod, node) {
    for (let n = node.parent; n; n = n.parent) {
      if (!isFunctionLike(n)) continue;
      const name = functionName(n);
      const params = n.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
      if (!name || params.every((p) => p === null)) return null;
      const named = new Set(params.filter((p) => p !== null));
      return references(node, named) ? { fn: n, name, params } : null;
    }
    return null;
  }

  /**
   * Every value `node` takes: its value as written, or, inside a helper
   * whose parameters it uses, its value at each call of that helper.
   *
   * @returns {(Value | null)[]}
   */
  function valuesOf(mod, node, depth = 0) {
    const plain = evaluate(mod, node);
    if ((isPathLike(plain) && plain.exact) || depth >= MAX_DEPTH) return [plain];
    const loop = loopAround(mod, node);
    if (loop) {
      return loop.values.map((v) => evaluate(mod, node, new Map([[loop.name, v]]), depth));
    }
    const helper = helperAround(mod, node);
    if (!helper) return [plain];
    const sites = mod.calls.get(helper.name) ?? [];
    if (sites.length === 0) return [plain];
    const out = [];
    for (const site of sites) {
      const choices = helper.params.map((param, i) => {
        if (param === null) return [null];
        const arg = site.arguments[i];
        if (arg) return valuesOf(mod, arg, depth + 1);
        const fallback = helper.fn.parameters[i]?.initializer;
        return [fallback ? evaluate(mod, fallback) : null];
      });
      let combos = [[]];
      for (const choice of choices) {
        combos = combos.flatMap((c) => choice.map((v) => [...c, v])).slice(0, MAX_COMBINATIONS);
      }
      for (const combo of combos) {
        const scope = new Map();
        helper.params.forEach((param, i) => {
          if (param !== null) scope.set(param, combo[i] ?? null);
        });
        out.push(evaluate(mod, node, scope, depth));
      }
    }
    return out;
  }

  /**
   * The path defaults a call to a package function applies: each parameter,
   * or destructured property, the call leaves out and whose default is a
   * path.
   *
   * @returns {Value[]}
   */
  function defaultsApplied(mod, call) {
    const callee = unwrap(call.expression);
    let target = null;
    if (ts.isIdentifier(callee)) {
      const binding = mod.bindings.get(callee.text);
      if (binding?.kind === "import") target = exportedFunction(binding.file, binding.name);
    } else if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const binding = mod.bindings.get(callee.expression.text);
      if (binding?.kind === "namespace") target = exportedFunction(binding.file, callee.name.text);
    }
    if (!target) return [];
    const out = [];
    target.fn.parameters.forEach((param, i) => {
      const arg = call.arguments[i];
      if (ts.isIdentifier(param.name)) {
        if (!arg && param.initializer && readsParam(target.fn, param.name.text)) {
          out.push(evaluate(target.mod, param.initializer));
        }
        return;
      }
      if (!ts.isObjectBindingPattern(param.name)) return;
      const given = arg && ts.isObjectLiteralExpression(unwrap(arg)) ? unwrap(arg) : null;
      // An argument it cannot read, or an object with a spread in it, may
      // supply any property, so no default is known to apply.
      if (arg && !given) return;
      if (given?.properties.some((prop) => ts.isSpreadAssignment(prop))) return;
      const named = new Set(
        (given?.properties ?? [])
          .map((p) => (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null))
          .filter(Boolean),
      );
      for (const el of param.name.elements) {
        const key = el.propertyName ?? el.name;
        if (!el.initializer || !ts.isIdentifier(key) || named.has(key.text)) continue;
        if (!ts.isIdentifier(el.name) || !readsParam(target.fn, el.name.text)) continue;
        out.push(evaluate(target.mod, el.initializer));
      }
    });
    return out.filter(isPathLike);
  }

  return { load, evaluate, valuesOf, defaultsApplied };
}

/**
 * Every read outside the package one test makes, its own and those of the
 * package modules it imports, directly or through others.
 *
 * `read` and `exists` default to the file system. A test passes its own, so
 * it can scan sources that exist only in the test.
 *
 * @param {string} testFile absolute path
 * @param {{
 *   packageDir?: string,
 *   repoRoot?: string,
 *   read?: (file: string) => string,
 *   exists?: (file: string) => boolean,
 * }} [options]
 * @returns {Read[]}
 */
export function testReads(testFile, options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const repoRoot = options.repoRoot ?? resolve(packageDir, "..", "..");
  const read = options.read ?? ((f) => readFileSync(f, "utf8"));
  const exists = options.exists ?? isFile;
  const project = createProject({ packageDir, read, exists });
  /** @type {Read[]} */
  const reads = [];
  const seen = new Set();

  const record = (value, mod, node) => {
    if (!isPathLike(value)) return;
    const abs = normalize(value.abs);
    if (isInside(abs, packageDir) || !isInside(abs, repoRoot)) return;
    if (abs.split(sep).includes("node_modules")) return;
    const path = toPosix(relative(repoRoot, abs));
    const via = mod.file === testFile ? "" : toPosix(relative(packageDir, mod.file));
    const key = `${path}\0${value.exact}\0${via}`;
    if (seen.has(key)) return;
    seen.add(key);
    const { line } = mod.source.getLineAndCharacterOfPosition(node.getStart(mod.source));
    reads.push({ path, exact: value.exact, line: line + 1, via });
  };

  const queue = [testFile];
  const visited = new Set();
  while (queue.length > 0) {
    const file = queue.shift();
    if (visited.has(file)) continue;
    visited.add(file);
    const mod = project.load(file);
    const isTest = file === testFile;
    const visit = (node) => {
      const specifier = specifierOf(node);
      // A package module's `import()` inside a function runs only if a test
      // calls that function, which this scan cannot see. A static import
      // always runs.
      const loads = isTest || !ts.isCallExpression(node) || atTopLevel(node);
      if (specifier !== null && specifier.startsWith(".") && loads) {
        const target = resolveModule(file, specifier, exists);
        if (isInside(target, packageDir)) queue.push(target);
        else record({ kind: "path", abs: target, exact: true }, mod, node);
      }
      const runs = isTest || (atTopLevel(node) && !inEntrypointBlock(node, mod.bindings));
      if (runs && ts.isExpression(node) && isUse(node)) {
        for (const value of project.valuesOf(mod, node)) record(value, mod, node);
      }
      if (runs && ts.isCallExpression(node)) {
        for (const value of project.defaultsApplied(mod, node)) record(value, mod, node);
      }
      ts.forEachChild(node, visit);
    };
    visit(mod.source);
  }
  return reads;
}

/** A turbo input glob as a regex over repository paths. */
export function globToRegExp(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*" && glob[i + 1] === "*") {
      out += ".*";
      i += 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The repository paths a package's turbo.json declares as inputs of both
 * `test:unit` and `test:coverage`, as `$TURBO_ROOT$/` globs with the prefix
 * removed. Full-line `//` comments are allowed, as turbo allows them.
 *
 * @param {string} text the package's turbo.json
 * @returns {string[]}
 */
export function declaredGlobs(text) {
  const json = JSON.parse(
    text
      .split("\n")
      .filter((line) => !/^\s*\/\//.test(line))
      .join("\n"),
  );
  const rooted = (task) =>
    (json.tasks?.[task]?.inputs ?? [])
      .filter((input) => input.startsWith("$TURBO_ROOT$/"))
      .map((input) => input.slice("$TURBO_ROOT$/".length));
  const coverage = new Set(rooted("test:coverage"));
  return rooted("test:unit").filter((glob) => coverage.has(glob));
}

/**
 * Whether the declared globs cover one read.
 *
 * An exact read is covered when a glob matches it, with or without a source
 * extension, or, for a directory, when a `<dir>/**` glob holds it. A read
 * known only by its prefix is covered when a `<dir>/**` glob holds that whole
 * prefix.
 *
 * @param {Read} read
 * @param {string[]} globs
 */
export function isDeclared(read, globs) {
  const { path, exact } = read;
  return globs.some((glob) => {
    if (glob.endsWith("/**")) {
      const dir = glob.slice(0, -3);
      if (path === dir || path.startsWith(`${dir}/`)) return true;
    }
    if (!exact || path === "") return false;
    const regex = globToRegExp(glob);
    if (regex.test(path)) return true;
    const stem = path.replace(/\.(?:js|mjs|ts|mts|tsx)$/, "");
    return [".ts", ".tsx", ".mts", ".mjs", ".js"].some((ext) => regex.test(stem + ext));
  });
}

/** Every test file in the package, relative to it, skipping node_modules. */
export function testFiles(packageDir = PACKAGE_DIR) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".test.ts")) out.push(toPosix(relative(packageDir, abs)));
    }
  };
  walk(packageDir);
  return out.sort();
}

/**
 * Each cached test's reads that the package's turbo.json does not declare.
 * A `*.tree.test.ts` file runs uncached, so it never appears here.
 *
 * @param {{ packageDir?: string }} [options]
 * @returns {{ test: string, undeclared: Read[] }[]}
 */
export function undeclaredReads(options = {}) {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const globs = declaredGlobs(readFileSync(join(packageDir, "turbo.json"), "utf8"));
  const out = [];
  for (const test of testFiles(packageDir)) {
    if (TREE_TEST.test(test)) continue;
    const undeclared = testReads(join(packageDir, test), { packageDir }).filter(
      (r) => !isDeclared(r, globs),
    );
    if (undeclared.length > 0) out.push({ test, undeclared });
  }
  return out;
}

/** One read as a line of a report. */
export function describeRead(read) {
  const what = read.exact ? read.path || "." : `${read.path || "."}/** (a path it cannot resolve)`;
  const where = read.via ? `${read.via}:${read.line}` : `line ${read.line}`;
  return `${what} (${where})`;
}

if (isEntrypoint(import.meta.url)) {
  const all = process.argv.includes("--all");
  const globs = declaredGlobs(readFileSync(join(PACKAGE_DIR, "turbo.json"), "utf8"));
  let failed = 0;
  for (const test of testFiles()) {
    const tree = TREE_TEST.test(test);
    const reads = testReads(join(PACKAGE_DIR, test));
    const undeclared = tree ? [] : reads.filter((r) => !isDeclared(r, globs));
    if (undeclared.length > 0) failed += 1;
    if (undeclared.length === 0 && !(all && reads.length > 0)) continue;
    console.log(`${test}${tree ? " (tree)" : ""}`);
    for (const r of reads) {
      const mark = tree ? "tree" : isDeclared(r, globs) ? "ok  " : "MISS";
      console.log(`  ${mark}  ${describeRead(r)}`);
    }
  }
  console.log(
    failed === 0
      ? "Every cached test declares what it reads outside tools/scripts."
      : `${failed} cached test(s) read files tools/scripts/turbo.json does not declare.`,
  );
  process.exit(failed === 0 ? 0 : 1);
}
