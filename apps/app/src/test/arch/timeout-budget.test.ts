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
// A function cannot run without being named, so case 2 terminates in case 1 or
// case 3. The two ways out of that are handled rather than hoped: a name that
// leaves the file is refused (rule 3, `exported`), because its callers are not
// all in view; and a name nothing mentions cannot run at all. What this does
// NOT cover is a test doing heavy work over a file list it was handed through a
// variable -- that is not enumerating, so it is outside the question above
// rather than a hole in it. The PR description says so in those words.
//
// TWO THINGS THE REACHABILITY SET GOT WRONG, both fixed in round five, and both
// the same shape: the set was right about what it contained and wrong about
// what it started from and where it stopped.
//
//   - It was seeded EMPTY, holding only local wrappers. So `productionFiles`
//     was something walkers call rather than a walker itself, and handing it
//     straight over -- `it("walks", productionFiles)`, `beforeAll(productionFiles)`
//     -- named no wrapper and contained no matching call. The most direct
//     spelling of the walk was the one spelling the set could not hold. It is
//     now seeded with the enumerator.
//   - It was rebuilt PER FILE from that file's own declarations, which assumes
//     a walker is declared beside its caller. An imported sibling helper never
//     entered it, so `it("scan", scan)` passed, and rule 3 could not catch the
//     helper either, because a non-test module is never judged. A call graph
//     does not stop at a file boundary, and this one no longer pretends to: the
//     fixpoint now closes over the whole program, which was already built.
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
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { APP_DIR, lineOf, listFiles, WHOLE_TREE_TIMEOUT_MS } from "./parse";

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

/**
 * The analysis context: one program over the arch suite and its probes, with
 * the host confined to `src/` exactly as route-guard.test.ts does it, so
 * platform packages resolve to nothing and the program stays small. Measured,
 * not estimated: 42 roots, 47 files, no lib and no node_modules; ~125ms to
 * build, ~400ms with all 8587 identifiers resolved. In CI, where the figure
 * that matters is the job, the app's coverage step read 153s before this change
 * and 158s after, on one cold-cache sample each (the turbo remote cache has been
 * answering 402 all day), while the job total went 349s -> 337s. So the cost is
 * real but below this job's run-to-run noise, and it is paid once in a beforeAll
 * rather than per test.
 *
 * The checker is here because WHICH DECLARATION A CALLEE RESOLVES TO is a
 * binding question, and a binding question is what a symbol table answers
 * exactly. The predicate used to compare the callee's spelling, so
 * `import { productionFiles as files }` and `arch.productionFiles()` were the
 * same walk under another name and it saw neither -- while a local function
 * that merely happened to be spelled `productionFiles` was reported although it
 * enumerates nothing. Matching text was wrong in both directions at once.
 *
 * EVERY ENTRY BELOW IS A SYMBOL RATHER THAN A NAME, because each rule asks "is
 * this the thing parse.ts declares?" and only a symbol answers that. Round four
 * resolved the enumerators and left the BUDGET CONSTANTS on string comparison,
 * so a local `const WHOLE_TREE_TIMEOUT_MS = 5_000` was accepted as the measured
 * one-minute budget: a whole-tree test could keep the exact 5000ms this file
 * exists to abolish while the enforcement test stayed green. Same mistake, same
 * file, same round, one half fixed. After making a correction the next question
 * is where else that mistake lives, starting with the file you are already in.
 */
type Symbols = {
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  /** `productionFiles` as declared in parse.ts, whatever a caller spells it. */
  readonly productionFiles: ts.Symbol;
  readonly listFiles: ts.Symbol;
  /** The two budgets as parse.ts declares them, so a look-alike is not one. */
  readonly wholeTreeBudget: ts.Symbol;
  readonly typeCheckedBudget: ts.Symbol;
};

type Context = Symbols & {
  /** Every declaration IN THE PROGRAM that can reach a whole-tree walk. */
  readonly walkers: ReadonlySet<ts.Symbol>;
  /** Every declaration in the program that can reach a `ts.Program` build. */
  readonly programs: ReadonlySet<ts.Symbol>;
};

const toAbs = (file: string): string => path.join(APP_DIR, file);
const toRel = (abs: string): string =>
  path.relative(APP_DIR, abs).split(path.sep).join("/");

function createProgram(roots: readonly string[]): ts.Program {
  const options: ts.CompilerOptions = {
    noEmit: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2024,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    baseUrl: APP_DIR,
    paths: { "@/*": ["src/*"] },
  };
  const base = ts.createCompilerHost(options, true);
  const inside = (abs: string): boolean => toRel(abs).startsWith("src/");
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (abs) => inside(abs) && base.fileExists(abs),
    readFile: (abs) => (inside(abs) ? base.readFile(abs) : undefined),
    directoryExists: (abs) => {
      const rel = toRel(abs);
      return (
        (rel === "" || rel === "src" || rel.startsWith("src/")) &&
        (base.directoryExists?.(abs) ?? false)
      );
    },
  };
  return ts.createProgram(roots.map(toAbs), options, host);
}

/**
 * The two enumerators, as declared. A checker whose subject has vanished must
 * fail loudly rather than quietly find nothing: silence would be indistinguish-
 * able from a clean suite, which is the failure this file exists to prevent.
 */
function contextOver(roots: readonly string[]): Context {
  const program = createProgram(roots);
  const checker = program.getTypeChecker();
  const parseFile = program.getSourceFile(toAbs(`${ARCH_DIR}/parse.ts`));
  if (parseFile === undefined)
    throw new Error("parse.ts is not in the program");
  const moduleSymbol = checker.getSymbolAtLocation(parseFile);
  if (moduleSymbol === undefined) throw new Error("parse.ts exports nothing");
  const exported = checker.getExportsOfModule(moduleSymbol);
  const find = (name: string): ts.Symbol => {
    const symbol = exported.find((candidate) => candidate.name === name);
    if (symbol === undefined) {
      throw new Error(`parse.ts no longer exports ${name}`);
    }
    return symbol;
  };
  const base: Symbols = {
    program,
    checker,
    productionFiles: find("productionFiles"),
    listFiles: find("listFiles"),
    wholeTreeBudget: find(WHOLE_TREE_BUDGET),
    typeCheckedBudget: find(TYPE_CHECKED_BUDGET),
  };
  return {
    ...base,
    // `productionFiles` IS a walker, not merely something walkers call. Seeding
    // it is the fixpoint's missing base case: `it("walks", productionFiles)`
    // contains no matching call and named no wrapper, so a set built only from
    // wrappers was empty exactly where the walk was most direct.
    //
    // `listFiles` is deliberately NOT seeded. It enumerates the whole tree only
    // when handed "src", which `enumeratesTree` already tests at the call; a
    // bare `listFiles` reference cannot walk the tree, because a registrar
    // hands its callback a test context rather than that string. Seeding it
    // would make every subtree scan a violation, and `subtree.test.ts` is the
    // probe that says so.
    walkers: carriers(base, enumeratesTreeIn(base), [base.productionFiles]),
    programs: carriers(base, buildsProgram, []),
  };
}

/** The declaration `node` names, following import aliases to the real one. */
function declarationOf(context: Symbols, node: ts.Node): ts.Symbol | undefined {
  const unalias = (symbol: ts.Symbol | undefined): ts.Symbol | undefined =>
    symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0
      ? context.checker.getAliasedSymbol(symbol)
      : symbol;
  // `{ scan }` binds a property whose name happens to match; the value it
  // carries is the mention, and only a dedicated lookup returns it.
  if (ts.isShorthandPropertyAssignment(node.parent)) {
    const value = context.checker.getShorthandAssignmentValueSymbol(
      node.parent,
    );
    const resolved = unalias(value);
    if (resolved !== undefined) return resolved;
  }
  const direct = unalias(context.checker.getSymbolAtLocation(node));
  if (direct !== undefined) return direct;
  // A value assigned from the enumerator — `const files = productionFiles` —
  // binds to the variable, not the import, so ask what it is instead.
  return unalias(context.checker.getTypeAtLocation(node).getSymbol());
}

function isDeclaration(
  context: Symbols,
  node: ts.Node,
  target: ts.Symbol,
): boolean {
  if (declarationOf(context, node) === target) return true;
  const type = context.checker.getTypeAtLocation(node).getSymbol();
  const unaliased =
    type !== undefined && (type.flags & ts.SymbolFlags.Alias) !== 0
      ? context.checker.getAliasedSymbol(type)
      : type;
  return unaliased === target;
}

/**
 * The whole production tree, enumerated. Resolved rather than matched, so a
 * renamed import, a namespace access and a re-export are the same walk.
 */
function enumeratesTreeIn(context: Symbols): CallTest {
  return (call) => {
    const callee = call.expression;
    if (isDeclaration(context, callee, context.productionFiles)) return true;
    if (!isDeclaration(context, callee, context.listFiles)) return false;
    const [argument] = call.arguments;
    if (argument === undefined) return false;
    // The argument's VALUE, not its spelling: `listFiles(SRC)` where
    // `const SRC = "src"` is the same walk as the literal, and asking the
    // checker for the type costs nothing here since it is already resolving
    // this callee.
    //
    // A type the checker cannot pin to a literal — `const root: string =
    // "src"`, or a parameter — counts as the tree. EXCLUDING a walk is the
    // direction that silently drops coverage: answering false here means no
    // budget is required, so an unprovable argument would buy an exemption by
    // being unreadable. Requiring the budget instead costs a named subtree
    // nothing (its literal resolves) and costs a widened one an explicit
    // timeout, which is the answer we would want anyway.
    const type = context.checker.getTypeAtLocation(argument);
    if (!type.isStringLiteral()) return true;
    return type.value === "src";
  };
}

/**
 * `createProgram(…)` or `ts.createProgram(…)`: the type-checked program the
 * larger budget is for. Matched by name rather than resolved, deliberately.
 * `ts` is outside this program by design, and the asymmetry is fail-safe:
 * failing to recognise a program build withholds the LARGER budget, so the
 * mistake makes the rule stricter. Failing to recognise an enumeration makes it
 * laxer, which is why that one is resolved and this one is not.
 */
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

/** Every declaration `node` mentions, itself included when it is a bare reference. */
function referencesIn(context: Symbols, node: ts.Node): ts.Symbol[] {
  const symbols: ts.Symbol[] = [];
  const take = (id: ts.Identifier): void => {
    const symbol = declarationOf(context, id);
    if (symbol !== undefined) symbols.push(symbol);
  };
  const visit = (current: ts.Node): void => {
    if (ts.isIdentifier(current) && isValueReference(current)) take(current);
    ts.forEachChild(current, visit);
  };
  visit(node);
  if (ts.isIdentifier(node) && isValueReference(node)) take(node);
  return symbols;
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
  readonly symbol: ts.Symbol | undefined;
  /** Its name leaves the file, so this file cannot see who calls it. */
  readonly exported: boolean;
  readonly line: number;
};

/** Every function this file names: `function f() {}` and `const f = () => …`. */
function namedFunctions(
  context: Symbols,
  sf: ts.SourceFile,
): readonly LocalFunction[] {
  const functions: LocalFunction[] = [];
  const exportedNames = new Set<string>();
  const byName = new Map<string, number>();
  const add = (
    name: string,
    node: ts.Node,
    declaration: ts.Declaration,
    id: ts.Identifier,
  ): void => {
    const exported =
      (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Export) !==
      0;
    byName.set(name, functions.length);
    functions.push({
      node,
      symbol: context.checker.getSymbolAtLocation(id),
      exported,
      line: lineOf(sf, declaration),
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      add(node.name.text, node, node, node.name);
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isFunctionLike(node.initializer)
    ) {
      add(node.name.text, node.initializer, node, node.name);
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
    const at = byName.get(name);
    if (at !== undefined) {
      const existing = functions[at];
      if (existing !== undefined)
        functions[at] = { ...existing, exported: true };
    }
  }
  return functions;
}

/**
 * The declarations whose bodies can reach `wanted`: directly, or by mentioning
 * another such declaration, plus `seed` as the base case. A fixpoint rather
 * than a recursive lookup, so a mutual pair or a chain of any depth is carried
 * rather than depending on which end is asked.
 *
 * OVER THE WHOLE PROGRAM, not one file. The set used to be rebuilt per test
 * file from that file's own declarations, which quietly assumed a walker is
 * always declared beside its caller. An imported sibling helper whose body
 * walks the tree never entered it, so `it("scan", scan)` and
 * `it("scan", () => scan())` both passed, and rule 3 could not catch the
 * helper either, because a non-test module is never judged. A call graph does
 * not stop at a file boundary; this one no longer pretends to. The program was
 * already built, so following an import is more of what this was doing rather
 * than a new mechanism.
 *
 * Each function's two facts -- does it call `wanted` directly, and what does it
 * mention -- are computed once, because the fixpoint revisits every not-yet-
 * found function on every pass and resolving identifiers is the expensive half.
 */
function carriers(
  context: Symbols,
  wanted: CallTest,
  seed: readonly ts.Symbol[],
): ReadonlySet<ts.Symbol> {
  const rows = context.program
    .getSourceFiles()
    .flatMap((sf) => namedFunctions(context, sf))
    .flatMap((local) =>
      local.symbol === undefined
        ? []
        : [
            {
              symbol: local.symbol,
              direct: makesCall(local.node, wanted),
              mentions: referencesIn(context, local.node),
            },
          ],
    );
  const found = new Set<ts.Symbol>(seed);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (found.has(row.symbol)) continue;
      if (row.direct || row.mentions.some((symbol) => found.has(symbol))) {
        found.add(row.symbol);
        changed = true;
      }
    }
  }
  return found;
}

/** Whether evaluating `node` can run a `wanted` call: it makes one, or it names something that does. */
function reaches(
  context: Symbols,
  node: ts.Node,
  wanted: CallTest,
  carrierSymbols: ReadonlySet<ts.Symbol>,
): boolean {
  return (
    makesCall(node, wanted) ||
    referencesIn(context, node).some((symbol) => carrierSymbols.has(symbol))
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

function judge(
  context: Context,
  file: string,
): { readonly found: Registration[]; readonly violations: string[] } {
  const sf = context.program.getSourceFile(toAbs(file));
  if (sf === undefined) throw new Error(`${file} is not in the program`);
  const enumeratesTree = enumeratesTreeIn(context);
  // Reachability spans the program and is computed once; rule 3 is the only
  // rule that is properly about THIS file, because "its name leaves the file"
  // is a question about this file's exports.
  const { walkers, programs } = context;
  const functions = namedFunctions(context, sf);
  const found: Registration[] = [];
  const violations: string[] = [];
  const at = (node: ts.Node): string =>
    `${RULE} ${file}:${String(lineOf(sf, node))}`;

  // Rule 3: a walker whose name leaves the file has callers this file cannot
  // see, so "charged at its mentions" stops being a claim anyone can check.
  for (const local of functions) {
    if (
      local.symbol !== undefined &&
      walkers.has(local.symbol) &&
      local.exported
    ) {
      violations.push(
        `${RULE} ${file}:${String(local.line)} exported ${local.symbol.name}`,
      );
    }
  }

  const visit = (node: ts.Node): void => {
    // Rule 2: every site that can run a walk sits under a budget.
    //
    // `productionFiles()` is ONE site. With the enumerator now in `walkers`,
    // the call and its own callee would both report and name the same line
    // twice, so a callee is skipped exactly when the call around it is already
    // counted. Only that case: a local walker INVOKED at collection scope --
    // `const SOURCES = scan()` -- is not an enumerating call, so its callee is
    // the only thing that reports it, and `helper-at-collection.test.ts` is the
    // probe that fails if this is widened to every callee.
    const coveredByItsCall = (id: ts.Identifier): boolean =>
      ts.isCallExpression(id.parent) &&
      id.parent.expression === id &&
      enumeratesTree(id.parent);
    const referenced =
      ts.isIdentifier(node) && isValueReference(node) && !coveredByItsCall(node)
        ? declarationOf(context, node)
        : undefined;
    const isSite =
      (ts.isCallExpression(node) && enumeratesTree(node)) ||
      (referenced !== undefined && walkers.has(referenced));
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
        reaches(context, callback, enumeratesTree, walkers)
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
        } else {
          // Which constant this IS, not what it is spelled. A local
          // `const WHOLE_TREE_TIMEOUT_MS = 5_000` wears the right name and
          // carries none of the measurement behind it; `shadowed` says the
          // name resolved somewhere other than parse.ts.
          const budget = declarationOf(context, timeout);
          if (budget === context.typeCheckedBudget) {
            if (!reaches(context, callback, buildsProgram, programs)) {
              violations.push(
                `${where} ${TYPE_CHECKED_BUDGET} without-program`,
              );
            }
          } else if (budget !== context.wholeTreeBudget) {
            const known =
              timeout.text === WHOLE_TREE_BUDGET ||
              timeout.text === TYPE_CHECKED_BUDGET;
            violations.push(
              `${where} ${timeout.text}${known ? " shadowed" : ""}`,
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { found, violations: violations.sort() };
}

/**
 * The arch suite's test files, at any depth under `src/test/arch`, probes
 * excluded.
 *
 * The old filter took only the TOP LEVEL of the directory -- it rejected any
 * path containing a `/` after `src/test/arch` -- so `src/test/arch/sub/x.test.ts`
 * was a file vitest runs and this rule never judged. That is closed here, and
 * it is free: `listFiles(ARCH_DIR)` walks one directory, not the tree.
 *
 * THE BOUNDARY THAT IS STILL OPEN, stated rather than hidden. The judged set is
 * the arch suite, which assumes whole-tree walks only live there. Nothing
 * enforces that -- `parse.ts` is importable from anywhere, and
 * `src/i18n/messages-types.test.ts` already imports it (for `APP_DIR` only, so
 * no walk escapes today; that was checked, not assumed). A whole-tree test
 * written one directory away would inherit the 5000ms default exactly as
 * `actions.test.ts` did, and this rule would have nothing to say about it.
 *
 * Closing it was built and measured rather than guessed at: judging every
 * `src/**\/*.test.ts` means 200 roots and 516 files instead of 50 and 55, and
 * takes the program from ~0.45s to ~3.5s, this file from 1.6s to 8.4s. It works
 * and it is sound -- and the first thing it reported was a true positive, this
 * file's own two `it`s, because the widened enumerator is itself a
 * `listFiles("src")` walk. It is not taken here: a fivefold cost on the
 * enforcement test is a trade for the maintainer to make, in a change whose
 * whole subject is tests that run too close to their budget.
 */
function judgedTestFiles(): string[] {
  return listFiles(ARCH_DIR).filter(
    (file) => file.endsWith(".test.ts") && !file.startsWith(`${PROBES}/`),
  );
}

function probeFiles(): string[] {
  return listFiles(PROBES).filter((file) => /\.tsx?$/.test(file));
}

let context: Context;

beforeAll(() => {
  context = contextOver([...judgedTestFiles(), ...probeFiles()]);
}, WHOLE_TREE_TIMEOUT_MS);

const judged = (file: string): string[] => judge(context, file).violations;
const probe = (name: string): string[] => judged(`${PROBES}/${name}`);

describe("whole-tree timeout budget", () => {
  it("every whole-tree test in the arch suite declares a named budget", () => {
    const files = judgedTestFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(judged)).toEqual([]);
  }, WHOLE_TREE_TIMEOUT_MS);

  it("finds whole-tree registrations to judge, in more than one file", () => {
    const perFile = judgedTestFiles().map((file) => ({
      file,
      found: judge(context, file).found,
    }));
    const carrying = perFile.filter((entry) => entry.found.length > 0);
    // A checker that matches nothing passes every file; these two floors fail
    // if the detector stops recognising the suite it is meant to police.
    expect(carrying.length).toBeGreaterThan(3);
    expect(perFile.flatMap((entry) => entry.found).length).toBeGreaterThan(8);
  }, WHOLE_TREE_TIMEOUT_MS);

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

  it("a renamed import is the same walk", () => {
    expect(probe("renamed.test.ts")).toEqual([
      `${RULE} ${PROBES}/renamed.test.ts:5 it none`,
    ]);
  });

  it("a namespace access is the same walk", () => {
    expect(probe("namespace.test.ts")).toEqual([
      `${RULE} ${PROBES}/namespace.test.ts:5 it none`,
    ]);
  });

  it("a value alias of the enumerator is the same walk", () => {
    // Two lines, because `const files = productionFiles` at module scope is a
    // mention of a walker exactly as `const run = scan` is in aliased.test.ts.
    // The mention is charged where it is written; this is the conservative
    // direction, and it is the same rule both probes have always encoded.
    expect(probe("value-alias.test.ts")).toEqual([
      `${RULE} ${PROBES}/value-alias.test.ts:6 collection-scope`,
      `${RULE} ${PROBES}/value-alias.test.ts:8 it none`,
    ]);
  });

  it("a re-export is the same walk", () => {
    expect(probe("re-export.test.ts")).toEqual([
      `${RULE} ${PROBES}/re-export.test.ts:5 it none`,
    ]);
  });

  it("an object shorthand carries the walker, and is a mention", () => {
    expect(probe("shorthand.test.ts")).toEqual([
      `${RULE} ${PROBES}/shorthand.test.ts:10 collection-scope`,
    ]);
  });

  // The two rows that keep the change honest. Recognising a walk under another
  // name has to make the predicate more ACCURATE, not merely louder, so this
  // pair is the converse of the four above: the same declaration under a
  // different spelling must flag, and a different declaration under the same
  // spelling must not. Matching the callee's text got both wrong, in opposite
  // directions -- it missed every alias, and it flagged `homonym.test.ts`,
  // which enumerates nothing at all. One lookup answers both.
  it("a local function spelled like the enumerator is not the enumerator", () => {
    expect(probe("homonym.test.ts")).toEqual([]);
  });

  it("a renamed import under a named budget is recognised and acquitted", () => {
    expect(probe("renamed-ok.test.ts")).toEqual([]);
  });

  // ROUND 5. Three findings, one defect and one repeat. Findings 1 and 2 are
  // the same reachability set built wrong: seeded without its own base case and
  // closed over one file instead of the program. Finding 3 is round four's
  // identity fix applied to the half of the file that had been left on string
  // comparison.
  it("the enumerator handed straight to a registrar is the walk", () => {
    expect(probe("direct-callback.test.ts")).toEqual([
      `${RULE} ${PROBES}/direct-callback.test.ts:7 it none`,
    ]);
    expect(probe("direct-hook.test.ts")).toEqual([
      `${RULE} ${PROBES}/direct-hook.test.ts:5 beforeAll none`,
    ]);
  });

  it("the same hand-off under a named budget is acquitted", () => {
    expect(probe("direct-callback-ok.test.ts")).toEqual([]);
  });

  it("a walker imported from another module is still a walker", () => {
    expect(probe("imported-helper.test.ts")).toEqual([
      `${RULE} ${PROBES}/imported-helper.test.ts:5 it none`,
    ]);
    expect(probe("imported-helper-call.test.ts")).toEqual([
      `${RULE} ${PROBES}/imported-helper-call.test.ts:5 it none`,
    ]);
  });

  it("an imported helper that reaches no enumeration stays clean", () => {
    expect(probe("imported-pure.test.ts")).toEqual([]);
  });

  it("SITE AUDIT: a registrar is still recognised by name (lax, open)", () => {
    // Found by auditing this file for the round-5 mistake rather than by
    // review. `CALLBACK_AT` keys on the identifier's TEXT, so a local `it` that
    // is not vitest's is accepted as a registrar: the walk is treated as
    // budgeted and actually runs during collection. It is the same
    // name-for-symbol error as the budget constant, and it is NOT fixed here --
    // `vitest` is outside this program by construction (noLib, types: [], a
    // host that refuses anything outside src/), so there is no symbol to
    // compare against. Asserted as it behaves, so the limit is visible and a
    // future fix has a failing expectation to flip.
    expect(probe("shadowed-registrar.test.ts")).toEqual([]);
  });

  it("SITE AUDIT: an imported module's initializer is not judged (lax, open)", () => {
    // Raised in review as a sixth spelling, and it is real: `module-init.test.ts`
    // imports a value whose sibling computes it with `productionFiles()` at
    // MODULE scope, so the walk runs during collection, one module away, with no
    // budget over it. `judge` opens only `.test.ts` files, and `carriers` records
    // named function bodies, so an initializer is neither judged nor a carrier.
    //
    // NOT fixed here, deliberately. Five rounds have each widened the judged set
    // by one shape; this one has zero instances in the tree (audited: the only
    // module-scope walks are in parse.ts's own definitions and in probes). The
    // stopping rule set before this round was that a sixth shape is stated as a
    // limit rather than chased, because a checker extended for a case nobody
    // writes buys complexity with no coverage. Asserted as it behaves, so the
    // boundary is executable and a future fix has a failing expectation to flip.
    expect(probe("module-init.test.ts")).toEqual([]);
  });

  it("a budget constant is the one parse.ts declares, not one so spelled", () => {
    expect(probe("shadowed-budget.test.ts")).toEqual([
      `${RULE} ${PROBES}/shadowed-budget.test.ts:9 it WHOLE_TREE_TIMEOUT_MS shadowed`,
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

  it("a root the checker cannot pin to a subtree counts as the tree", () => {
    // The exclusion is the direction that silently drops coverage, so it now
    // requires proof: an argument whose type is not a string literal is the
    // tree until shown otherwise. Every real subtree in the suite resolves to a
    // literal, so this costs the existing call sites nothing.
    expect(probe("widened-root.test.ts")).toEqual([
      `${RULE} ${PROBES}/widened-root.test.ts:8 it none`,
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
      "direct-callback-ok.test.ts",
      "direct-callback.test.ts",
      "direct-hook.test.ts",
      "exported.test.ts",
      "helper-at-collection.test.ts",
      "helper.test.ts",
      "homonym.test.ts",
      "hook.test.ts",
      "imported-helper-call.test.ts",
      "imported-helper.test.ts",
      "imported-pure.test.ts",
      "imported-walker.ts",
      "list-src.test.ts",
      "magic-number.test.ts",
      "missing.test.ts",
      "module-init-source.ts",
      "module-init.test.ts",
      "named-callback.test.ts",
      "namespace.test.ts",
      "ok.test.ts",
      "program.test.ts",
      "re-export.test.ts",
      "re-exported-source.ts",
      "renamed-ok.test.ts",
      "renamed.test.ts",
      "shadowed-budget.test.ts",
      "shadowed-registrar.test.ts",
      "shorthand.test.ts",
      "subtree.test.ts",
      "value-alias.test.ts",
      "widened-root.test.ts",
      "wrong-budget.test.ts",
    ]);
  });

  it("names the budget it enforces", () => {
    expect(WHOLE_TREE_TIMEOUT_MS).toBe(60_000);
  });
});
