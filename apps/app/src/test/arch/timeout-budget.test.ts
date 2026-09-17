// INV-25 (ARCHITECTURE.md §4): an architecture test that walks the whole
// production tree declares its own budget. `productionFiles()` and
// `listFiles("src")` enumerate all ~305 production modules, and a test that
// reads and parses them is not a unit: vitest's 5000ms default is a unit-test
// budget, and a whole-tree probe that inherits it fails on load rather than on
// code. CI run 35210969739 (job 105168115962) failed `actions.test.ts` at
// exactly that, on a tree nothing had changed; on an idle machine the same
// suite already read 3695ms, 74% of the default, in `catalog-used.test.ts`.
//
// Adding the argument test by test leaves the next whole-tree probe inheriting
// the unit budget in silence, so this test parses the arch suite itself and
// holds it to two rules.
//
// 1. Every `it`, `test`, `beforeAll` and `beforeEach` whose callback reaches a
//    whole-tree enumeration — directly or through a function declared in the
//    same file — passes WHOLE_TREE_TIMEOUT_MS or TYPE_CHECKED_TREE_TIMEOUT_MS as
//    its timeout. A bare number fails too: the budget is a named constant with
//    the measurements behind it, not a figure copied between files.
// 2. A whole-tree enumeration evaluates inside one of those callbacks, or inside
//    a named function they call. The same walk at module or `describe` scope
//    runs during collection, where no timeout of any kind governs it: it hangs
//    the file instead of failing it, which is the worse of the two failures and
//    the one no per-test argument can fix.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  lineOf,
  listFiles,
  parse,
  readSource,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

const RULE = "timeout-budget";
const ARCH_DIR = "src/test/arch";
const PROBES = "src/test/arch/probes/timeout-budget";

/** The registrars that take a timeout as the argument after their callback. */
const REGISTRARS: ReadonlySet<string> = new Set([
  "it",
  "test",
  "beforeAll",
  "beforeEach",
]);

/** The whole-tree budget: always admissible, since it is the tighter of the two. */
const WHOLE_TREE_BUDGET = "WHOLE_TREE_TIMEOUT_MS";
/**
 * The type-checked budget, ten times the other. parse.ts justifies it by the
 * ~5.2k declaration files a type-checked program loads, so it is admissible
 * only to a callback that builds one. Left interchangeable, the name alone
 * would hand any whole-tree test a ten-minute budget, and the distinction
 * between the two constants would be documentation rather than enforcement.
 */
const TYPE_CHECKED_BUDGET = "TYPE_CHECKED_TREE_TIMEOUT_MS";

/** The whole production tree, enumerated: `productionFiles()` and `listFiles("src")`. */
function enumeratesTree(call: ts.CallExpression): boolean {
  if (!ts.isIdentifier(call.expression)) return false;
  if (call.expression.text === "productionFiles") return true;
  if (call.expression.text !== "listFiles") return false;
  const [argument] = call.arguments;
  return (
    argument !== undefined &&
    ts.isStringLiteral(argument) &&
    argument.text === "src"
  );
}

type FunctionNode = ts.ArrowFunction | ts.FunctionExpression;

function isFunctionArgument(node: ts.Node): node is FunctionNode {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

/**
 * Every function declared in the file, by name: `function f() {}` and
 * `const f = () => …`. A test reaches the tree through these, so they carry the
 * cost into its budget. A plain value — `const SOURCES = productionFiles()` — is
 * deliberately not one: it is already the walk rule 2 refuses, and charging it
 * again to every test that reads the value would name tests that walk nothing.
 */
function localFunctions(sf: ts.SourceFile): ReadonlyMap<string, ts.Node> {
  const functions = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      functions.set(node.name.text, node.body);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionArgument(node.initializer)
    ) {
      functions.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return functions;
}

/** `createProgram(…)` or `ts.createProgram(…)`: the type-checked program the larger budget is for. */
function buildsProgram(call: ts.CallExpression): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "createProgram";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "createProgram"
  );
}

/** Whether `node` makes a call `wanted` accepts, or calls something in the same file that does. */
function reaches(
  node: ts.Node,
  functions: ReadonlyMap<string, ts.Node>,
  wanted: (call: ts.CallExpression) => boolean,
  seen: Set<string> = new Set(),
): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(current)) {
      if (wanted(current)) {
        found = true;
        return;
      }
      if (ts.isIdentifier(current.expression)) {
        const name = current.expression.text;
        const body = functions.get(name);
        if (body !== undefined && !seen.has(name)) {
          seen.add(name);
          if (reaches(body, functions, wanted, seen)) {
            found = true;
            return;
          }
        }
      }
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** Whether `node` is the callback a registrar was handed, so a budget governs it. */
function isRegistrarCallback(node: ts.Node): boolean {
  const call = node.parent;
  return (
    ts.isCallExpression(call) &&
    ts.isIdentifier(call.expression) &&
    REGISTRARS.has(call.expression.text) &&
    call.arguments.some((argument) => argument === node)
  );
}

/** Whether `node` is a function this file gave a name to, whose cost is charged where it is called. */
function isNamedLocalFunction(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return node.name !== undefined;
  const parent = node.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  );
}

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * Whether an enumeration evaluates under some budget: inside a registrar's
 * callback, or inside a named function a callback can call. Anything else runs
 * at module or `describe` scope, during collection, ungoverned.
 */
function isBudgeted(call: ts.CallExpression): boolean {
  let node: ts.Node = call.parent;
  while (!ts.isSourceFile(node)) {
    if (
      isFunctionLike(node) &&
      (isRegistrarCallback(node) || isNamedLocalFunction(node))
    ) {
      return true;
    }
    node = node.parent;
  }
  return false;
}

type WholeTreeTest = {
  /** `it`, `test`, `beforeAll` or `beforeEach`. */
  readonly registrar: string;
  readonly line: number;
};

/** Every registration in the file whose callback reaches the whole tree, and both rules' findings. */
function wholeTreeTests(sf: ts.SourceFile): {
  readonly found: WholeTreeTest[];
  readonly violations: string[];
} {
  const functions = localFunctions(sf);
  const found: WholeTreeTest[] = [];
  const violations: string[] = [];
  const file = sf.fileName;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (enumeratesTree(node) && !isBudgeted(node)) {
        violations.push(
          `${RULE} ${file}:${String(lineOf(sf, node))} collection-scope`,
        );
      }
      if (
        ts.isIdentifier(node.expression) &&
        REGISTRARS.has(node.expression.text)
      ) {
        const registrar = node.expression.text;
        const args = [...node.arguments];
        const at = args.findIndex(isFunctionArgument);
        const callback = at === -1 ? undefined : args[at];
        if (
          callback !== undefined &&
          reaches(callback, functions, enumeratesTree)
        ) {
          const line = lineOf(sf, node);
          found.push({ registrar, line });
          const timeout = args[at + 1];
          const where = `${RULE} ${file}:${String(line)} ${registrar}`;
          if (timeout === undefined) {
            violations.push(`${where} none`);
          } else if (!ts.isIdentifier(timeout)) {
            violations.push(
              `${where} ${timeout.getText(sf).replace(/\s+/g, " ")}`,
            );
          } else if (
            timeout.text === TYPE_CHECKED_BUDGET &&
            !reaches(callback, functions, buildsProgram)
          ) {
            violations.push(`${where} ${TYPE_CHECKED_BUDGET} without-program`);
          } else if (
            timeout.text !== WHOLE_TREE_BUDGET &&
            timeout.text !== TYPE_CHECKED_BUDGET
          ) {
            violations.push(`${where} ${timeout.text}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, violations: violations.sort() };
}

function budgetViolations(source: SourceText): string[] {
  return wholeTreeTests(parse(source)).violations;
}

/** The arch suite's own test files: `src/test/arch/*.test.ts`, probes excluded. */
function archTestFiles(): string[] {
  return listFiles(ARCH_DIR).filter(
    (file) =>
      file.endsWith(".test.ts") &&
      !file.slice(ARCH_DIR.length + 1).includes("/"),
  );
}

const probe = (name: string): string[] =>
  budgetViolations(readSource(`${PROBES}/${name}`));

describe("whole-tree timeout budget", () => {
  it("every whole-tree test in the arch suite declares a named budget", () => {
    const files = archTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap((file) => budgetViolations(readSource(file)))).toEqual(
      [],
    );
  });

  it("finds whole-tree tests to judge, in more than one file", () => {
    const perFile = archTestFiles().map((file) => ({
      file,
      found: wholeTreeTests(parse(readSource(file))).found,
    }));
    const carrying = perFile.filter((entry) => entry.found.length > 0);
    // A checker that matches nothing passes every file; these two floors fail
    // if the detector stops recognising the suite it is meant to police.
    expect(carrying.length).toBeGreaterThan(3);
    expect(perFile.flatMap((entry) => entry.found).length).toBeGreaterThan(8);
  });

  it("a budget on the it, on a beforeAll and on a helper's caller passes", () => {
    expect(probe("ok.test.ts")).toEqual([]);
  });

  it("a whole-tree test with no timeout fails", () => {
    expect(probe("missing.test.ts")).toEqual([
      `${RULE} ${PROBES}/missing.test.ts:5 it none`,
    ]);
  });

  it("a walk at module scope fails: collection has no budget to exceed", () => {
    expect(probe("collected.test.ts")).toEqual([
      `${RULE} ${PROBES}/collected.test.ts:5 collection-scope`,
    ]);
  });

  it("reaches the tree through a function declared in the same file", () => {
    expect(probe("helper.test.ts")).toEqual([
      `${RULE} ${PROBES}/helper.test.ts:9 it none`,
    ]);
  });

  it('listFiles("src") counts, and a named subtree does not', () => {
    expect(probe("list-src.test.ts")).toEqual([
      `${RULE} ${PROBES}/list-src.test.ts:5 it none`,
    ]);
    expect(probe("subtree.test.ts")).toEqual([]);
  });

  it("a bare number is not a budget", () => {
    expect(probe("magic-number.test.ts")).toEqual([
      `${RULE} ${PROBES}/magic-number.test.ts:5 it 60_000`,
    ]);
  });

  it("the two budgets are not interchangeable: ten minutes needs a program", () => {
    expect(probe("wrong-budget.test.ts")).toEqual([
      `${RULE} ${PROBES}/wrong-budget.test.ts:10 it TYPE_CHECKED_TREE_TIMEOUT_MS without-program`,
    ]);
    expect(probe("program.test.ts")).toEqual([]);
  });

  it("a beforeAll that walks the tree needs one too", () => {
    expect(probe("hook.test.ts")).toEqual([
      `${RULE} ${PROBES}/hook.test.ts:7 beforeAll none`,
    ]);
  });

  it("every probe file is placed", () => {
    expect(listFiles(PROBES).map((f) => f.slice(PROBES.length + 1))).toEqual([
      "collected.test.ts",
      "helper.test.ts",
      "hook.test.ts",
      "list-src.test.ts",
      "magic-number.test.ts",
      "missing.test.ts",
      "ok.test.ts",
      "program.test.ts",
      "subtree.test.ts",
      "wrong-budget.test.ts",
    ]);
  });

  it("names the budget it enforces", () => {
    expect(WHOLE_TREE_TIMEOUT_MS).toBe(60_000);
  });
});
