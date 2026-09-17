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
// the unit budget in silence, so this test parses the arch suite itself. It asks
// one question of every walk: CAN THIS ENUMERATION RUN WITHOUT A DECLARED
// BUDGET? Three earlier revisions asked where the walk was written instead --
// literal call at collection scope, then one call deep through a helper, then
// inside a function handed to `it` by name -- and each closed one spelling and
// left the next open. Position is a proxy. Reachability is the property.
//
// THE ARGUMENT THAT THE CLASS IS CLOSED. An enumeration runs when the code
// holding it runs, and the only construct that defers running is a function. So
// every enumeration, and every mention of a function that can reach one, is a
// SITE, and each site sits in exactly one of three places:
//
//   1. inside a registrar's callback argument -- `it`, `test`, `beforeAll`,
//      `beforeEach`, `afterAll`, `afterEach`. Budgeted, and rule 1 checks that
//      the budget is one of the named constants.
//   2. inside a function this file names. That body runs only where the name is
//      mentioned, and every mention is itself a site, checked by this same walk.
//      The exemption is not "it looks contained", it is "it is charged there".
//   3. anywhere else -- module or `describe` scope. It runs during collection,
//      where no timeout of any kind governs it. Rule 2 rejects it.
//
// A file-local function cannot run without being named, so case 2 terminates in
// case 1 or case 3. The two ways out of that are handled rather than hoped: a
// name that leaves the file is refused (rule 3, `exported`), because its callers
// are not in view; and a name this file never mentions cannot run at all. What
// this does NOT cover is a test doing heavy work over a file list it was handed
// through a variable -- that is not enumerating, so it is outside the question
// above rather than a hole in it. The PR description says so in those words.
//
// Rule 2 also exists because moving a slow check to module scope LOOKS like the
// remedy for rule 1 -- no testTimeout applies there, so the timeout stops
// failing. It does not remove the race; it removes the budget. Work outside a
// budget cannot fail cleanly, only hang: a failure that named a file and a line
// becomes a worker that sits there until the job timeout with no diagnostic at
// all. Three walks in this suite had drifted to collection scope when this test
// landed, one of them proposed in review as the fix for exactly the 5000ms
// timeout rule 1 governs. If you are reading this because rule 1 just failed
// you, the answer is the named budget, not a quieter scope.
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

/**
 * Where each registrar takes its callback; the timeout is the argument after it.
 *
 * Fixed indices rather than "the first argument that is a function". That search
 * returned -1 for `it("scans", scan)`, because the callback is an identifier —
 * and -1 did not fail. It read as an ordinary index, so the rule went on to
 * evaluate something perfectly true about a different argument and reported
 * success. A check that cannot find its subject must say so; a sentinel that
 * looks like an answer lets it pass while examining the wrong node. The fix is
 * not a better search, it is making "absent" unrepresentable: a registrar this
 * file does not know is not in the map, and a callback that is not there is
 * `undefined` rather than the thing at index -1.
 */
const CALLBACK_AT: ReadonlyMap<string, number> = new Map([
  ["it", 1],
  ["test", 1],
  ["beforeAll", 0],
  ["beforeEach", 0],
  ["afterAll", 0],
  ["afterEach", 0],
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

type CallTest = (call: ts.CallExpression) => boolean;

/** The whole production tree, enumerated: `productionFiles()` and `listFiles("src")`. */
const enumeratesTree: CallTest = (call) => {
  if (!ts.isIdentifier(call.expression)) return false;
  if (call.expression.text === "productionFiles") return true;
  if (call.expression.text !== "listFiles") return false;
  const [argument] = call.arguments;
  return (
    argument !== undefined &&
    ts.isStringLiteral(argument) &&
    argument.text === "src"
  );
};

/** `createProgram(…)` or `ts.createProgram(…)`: the type-checked program the larger budget is for. */
const buildsProgram: CallTest = (call) => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "createProgram";
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "createProgram"
  );
};

function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

/**
 * Whether this identifier *uses* a binding, rather than introducing or labelling
 * one. A declaration's own name, a parameter, a property key and an imported
 * name are spellings, not mentions; only a mention can make a function run.
 */
function isValueReference(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (
    ts.isFunctionDeclaration(parent) ||
    ts.isFunctionExpression(parent) ||
    ts.isClassDeclaration(parent)
  ) {
    return parent.name !== id;
  }
  if (
    ts.isVariableDeclaration(parent) ||
    ts.isParameter(parent) ||
    ts.isBindingElement(parent)
  ) {
    return parent.name !== id;
  }
  if (ts.isPropertyAccessExpression(parent)) return parent.name !== id;
  if (ts.isPropertyAssignment(parent)) return parent.name !== id;
  if (ts.isQualifiedName(parent)) return parent.right !== id;
  return !(
    ts.isImportSpecifier(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isImportClause(parent) ||
    ts.isNamespaceImport(parent)
  );
}

/** Every name `node` mentions, itself included when it is a bare reference. */
function referencesIn(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && isValueReference(current)) {
      names.push(current.text);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (ts.isIdentifier(node) && isValueReference(node)) names.push(node.text);
  return names;
}

function makesCall(node: ts.Node, wanted: CallTest): boolean {
  let found = false;
  const visit = (current: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(current) && wanted(current)) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

type LocalFunction = {
  readonly node: ts.Node;
  /** Its name leaves the file, so this file cannot see who calls it. */
  readonly exported: boolean;
  readonly line: number;
};

/** Every function this file names: `function f() {}` and `const f = () => …`. */
function localFunctions(sf: ts.SourceFile): ReadonlyMap<string, LocalFunction> {
  const functions = new Map<string, LocalFunction>();
  const exportedNames = new Set<string>();
  const add = (
    name: string,
    node: ts.Node,
    declaration: ts.Declaration,
  ): void => {
    const exported =
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
      0;
    functions.set(name, { node, exported, line: lineOf(sf, declaration) });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node, node);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionLike(node.initializer)
    ) {
      add(node.name.text, node.initializer, node);
    } else if (
      ts.isExportDeclaration(node) &&
      node.exportClause &&
      ts.isNamedExports(node.exportClause)
    ) {
      for (const element of node.exportClause.elements) {
        exportedNames.add((element.propertyName ?? element.name).text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const name of exportedNames) {
    const existing = functions.get(name);
    if (existing !== undefined) {
      functions.set(name, { ...existing, exported: true });
    }
  }
  return functions;
}

/**
 * The names whose bodies can reach `wanted`: directly, or by mentioning another
 * such name. A fixpoint rather than a recursive lookup, so a mutual pair or a
 * chain of any depth is carried rather than depending on which end is asked.
 */
function carriers(
  functions: ReadonlyMap<string, LocalFunction>,
  wanted: CallTest,
): ReadonlySet<string> {
  const found = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, local] of functions) {
      if (found.has(name)) continue;
      if (
        makesCall(local.node, wanted) ||
        referencesIn(local.node).some((reference) => found.has(reference))
      ) {
        found.add(name);
        changed = true;
      }
    }
  }
  return found;
}

/** Whether evaluating `node` can run a `wanted` call: it makes one, or it names something that does. */
function reaches(
  node: ts.Node,
  wanted: CallTest,
  carrierNames: ReadonlySet<string>,
): boolean {
  return (
    makesCall(node, wanted) ||
    referencesIn(node).some((reference) => carrierNames.has(reference))
  );
}

/** Whether `node` is a function this file gave a name to, so its cost is charged at its mentions. */
function isNamedLocalFunction(node: ts.Node): boolean {
  if (ts.isFunctionDeclaration(node)) return node.name !== undefined;
  const parent = node.parent;
  return (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === node &&
    ts.isIdentifier(parent.name)
  );
}

/**
 * Whether a site runs under a declared budget. Walking out from the site, the
 * first of these wins: it is the callback a registrar was handed (budgeted --
 * rule 1 checks which budget), or it is inside a function this file names
 * (charged at that name's mentions, each a site in its own right). Reaching the
 * source file means neither ever applied: it runs during collection.
 */
function isBudgeted(site: ts.Node): boolean {
  let child: ts.Node = site;
  let node: ts.Node = site.parent;
  while (!ts.isSourceFile(node)) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const at = CALLBACK_AT.get(node.expression.text);
      if (at !== undefined && node.arguments[at] === child) return true;
    }
    if (isFunctionLike(node) && isNamedLocalFunction(node)) return true;
    child = node;
    node = node.parent;
  }
  return false;
}

type Registration = {
  /** `it`, `test`, `beforeAll`, `beforeEach`, `afterAll` or `afterEach`. */
  readonly registrar: string;
  readonly line: number;
};

function judge(sf: ts.SourceFile): {
  readonly found: Registration[];
  readonly violations: string[];
} {
  const functions = localFunctions(sf);
  const walkers = carriers(functions, enumeratesTree);
  const programs = carriers(functions, buildsProgram);
  const found: Registration[] = [];
  const violations: string[] = [];
  const file = sf.fileName;
  const at = (node: ts.Node): string =>
    `${RULE} ${file}:${String(lineOf(sf, node))}`;

  // Rule 3: a walker whose name leaves the file has callers this file cannot
  // see, so "charged at its mentions" stops being a claim anyone can check.
  for (const [name, local] of functions) {
    if (walkers.has(name) && local.exported) {
      violations.push(`${RULE} ${file}:${String(local.line)} exported ${name}`);
    }
  }

  const visit = (node: ts.Node): void => {
    // Rule 2: every site that can run a walk sits under a budget.
    const isSite =
      (ts.isCallExpression(node) && enumeratesTree(node)) ||
      (ts.isIdentifier(node) &&
        walkers.has(node.text) &&
        isValueReference(node));
    if (isSite && !isBudgeted(node)) {
      violations.push(`${at(node)} collection-scope`);
    }

    // Rule 1: a registration whose callback can run a walk names its budget.
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const registrar = node.expression.text;
      const index = CALLBACK_AT.get(registrar);
      const callback = index === undefined ? undefined : node.arguments[index];
      if (
        index !== undefined &&
        callback !== undefined &&
        reaches(callback, enumeratesTree, walkers)
      ) {
        found.push({ registrar, line: lineOf(sf, node) });
        const timeout = node.arguments[index + 1];
        const where = `${at(node)} ${registrar}`;
        if (timeout === undefined) {
          violations.push(`${where} none`);
        } else if (!ts.isIdentifier(timeout)) {
          violations.push(
            `${where} ${timeout.getText(sf).replace(/\s+/g, " ")}`,
          );
        } else if (
          timeout.text === TYPE_CHECKED_BUDGET &&
          !reaches(callback, buildsProgram, programs)
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
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, violations: violations.sort() };
}

function budgetViolations(source: SourceText): string[] {
  return judge(parse(source)).violations;
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

  it("finds whole-tree registrations to judge, in more than one file", () => {
    const perFile = archTestFiles().map((file) => ({
      file,
      found: judge(parse(readSource(file))).found,
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

  it("a helper called at collection scope fails, one call deep", () => {
    expect(probe("helper-at-collection.test.ts")).toEqual([
      `${RULE} ${PROBES}/helper-at-collection.test.ts:14 collection-scope`,
    ]);
  });

  it("a named function handed to a registrar is still its callback", () => {
    expect(probe("named-callback.test.ts")).toEqual([
      `${RULE} ${PROBES}/named-callback.test.ts:10 it none`,
    ]);
  });

  it("a walker mentioned at collection scope fails however it is spelled", () => {
    expect(probe("aliased.test.ts")).toEqual([
      `${RULE} ${PROBES}/aliased.test.ts:10 collection-scope`,
    ]);
  });

  it("a walker whose name leaves the file has callers this file cannot see", () => {
    expect(probe("exported.test.ts")).toEqual([
      `${RULE} ${PROBES}/exported.test.ts:4 exported scan`,
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
      "aliased.test.ts",
      "collected.test.ts",
      "exported.test.ts",
      "helper-at-collection.test.ts",
      "helper.test.ts",
      "hook.test.ts",
      "list-src.test.ts",
      "magic-number.test.ts",
      "missing.test.ts",
      "named-callback.test.ts",
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
