#!/usr/bin/env node
/**
 * codemod-db-mock-org-seam.mjs — a test that substitutes the tenant transaction
 * seam substitutes the organisation-wide one the same way.
 *
 * WHY. `@oxagen/database` now exports three transaction seams: `withTenantDb`
 * (one workspace), `withOrgDb` (the organisation, ADR-086) and `withSystemDb`
 * (the audited bypass). A unit test that mocks the module writes
 *
 *     vi.mock("@oxagen/database", async (importOriginal) => {
 *       const real = await importOriginal();
 *       return { ...real, withTenantDb: mocks.withTenantDb };
 *     });
 *
 * and the spread leaves `withOrgDb` as the REAL function. `withOrgDb` calls
 * `requireScope()` — exactly as `withTenantDb` always has, so this is not a
 * stricter seam, it is an unmocked one — and these suites establish no tenant
 * scope, because they replaced the seam that would have needed it. So a handler
 * whose role gate moved from `withTenantDb` to `withOrgDb` raises
 * `TenantScopeError` in every test that authorizes.
 *
 * The fix is NOT to make `withOrgDb` tolerate a missing scope. A seam that
 * proceeds without a tenant scope is the class of defect ADR-086 exists to
 * remove, and it would leave the organisation-wide seam weaker than the tenant
 * seam standing beside it. The fix is that the mock covers both.
 *
 * WHAT IT DOES. Inside a `vi.mock("@oxagen/database", …)` factory, a returned
 * object literal carrying `withTenantDb` and not `withOrgDb` is bound to a
 * const and re-spread with the alias:
 *
 *     const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
 *     return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
 *
 * Binding first rather than duplicating the initializer is the point.
 * `withTenantDb: vi.fn()` and `withTenantDb: async (fn) => …` are fresh values
 * per evaluation, so copying the TEXT would give the two seams two different
 * functions — and a suite asserting "called twice: once for role resolution,
 * once for insert" would then see one. The alias keeps ONE identity, which is
 * what the suite had before the role gate moved.
 *
 * Usage:
 *   node tools/scripts/codemod-db-mock-org-seam.mjs --write [paths…]   rewrite
 *   node tools/scripts/codemod-db-mock-org-seam.mjs        [paths…]    check
 *
 * In check mode it rewrites nothing and EXITS 1 if any mock is missing the
 * alias, which is how `check:db-mock-seams` keeps the rule from having to be
 * remembered. It prints every file it SKIPS and why.
 *
 * WHAT THIS CHECK IS AND IS NOT. It decides one syntactic question about one
 * object literal: does the factory that substitutes `withTenantDb` also
 * substitute `withOrgDb`. That is decidable from the parse — no module
 * resolution, no dataflow, no path sensitivity — which is exactly what
 * `check-org-sentinel-reads` could not say about the question IT was asked
 * (ADR-086). And its failure mode is the opposite one: a mock this check misses
 * produces a loud `TenantScopeError` the first time that test authorizes, never
 * a quietly wrong answer. It is worth having for the same reason that one was
 * not: the cost of being wrong here is a red suite, not a short SOC 2 export.
 *
 * THAT ARGUMENT IS ONLY WORTH ANYTHING IF THE SET IS THE WHOLE SET. The first
 * version of this file recognised `PropertyAssignment` with an `Identifier`
 * name and nothing else, so `{ ...real, withTenantDb }` — one of the two
 * spellings JavaScript treats as identical — was invisible to it, and
 * `packages/billing/src/metering.test.ts` reported clean while leaving the real
 * `withOrgDb` installed. A checker sound over a set built too narrowly reports
 * success for the cases it cannot see. So the recognised set is enumerated
 * here, with the forms that are OUT of it named rather than left unmentioned:
 *
 *   RECOGNISED as binding a name on the returned literal
 *     { withOrgDb: fn }            PropertyAssignment, Identifier name
 *     { "withOrgDb": fn }          PropertyAssignment, string-literal name
 *     { ["withOrgDb"]: fn }        ComputedPropertyName over a string literal
 *     { [`withOrgDb`]: fn }        ComputedPropertyName over a template with no
 *                                  substitutions. (A bare `` `withOrgDb`: fn ``
 *                                  is NOT a form — a template literal is not a
 *                                  PropertyName in an object literal, it parses
 *                                  as a tagged template. TypeScript's
 *                                  `PropertyName` union carries the node kind
 *                                  anyway, so it is read where it can appear.)
 *     { withOrgDb }                ShorthandPropertyAssignment
 *     { withOrgDb() {} }           MethodDeclaration
 *     { get withOrgDb() {} }       GetAccessorDeclaration
 *     { ...localConst }            SpreadAssignment of a same-file `const`
 *                                  bound to an object literal — resolved one
 *                                  hop at a time, transitively, cycle-guarded.
 *                                  This is the shape this codemod itself
 *                                  EMITS (`{ ...dbMock, withOrgDb: … }`), so
 *                                  not resolving it meant the check could not
 *                                  read its own output.
 *
 *   DELIBERATELY NOT RECOGNISED, each for a stated reason
 *     { set withOrgDb(v) {} }      A setter binds no readable value: it neither
 *                                  substitutes the seam nor satisfies the rule.
 *                                  Does not occur in this repo.
 *     { ...real }                  `real` is `await importOriginal()` — the
 *                                  REAL module. It is by construction the thing
 *                                  that leaves `withOrgDb` real, never the thing
 *                                  that substitutes `withTenantDb`, so it
 *                                  contributes nothing and is not an unknown.
 *                                  ~300 occurrences; recognised by the callee
 *                                  name `importOriginal`, not by the binding's.
 *     { [key]: fn }                A computed name that is not a literal needs
 *                                  dataflow to read — the exact thing that sank
 *                                  the static checker ADR-086 retired. Not
 *                                  decided; REPORTED as a skip.
 *     { ...whatever }              Any other spread — an import, a parameter, a
 *                                  call that is not `importOriginal`. Not
 *                                  decided; REPORTED as a skip.
 *     Object.assign(a, b)          A factory whose OWN return is not an object
 *                                  literal at all. Not decided; REPORTED as a
 *                                  skip when the factory mentions
 *                                  `withTenantDb`. Does not occur in this repo
 *                                  as a factory return — the five
 *                                  `Object.assign` calls under a database mock
 *                                  are all inside fake query-builder chains.
 *     vi.mock(spec, factoryFn)     A factory passed by REFERENCE rather than
 *                                  written at the call. This file's parse holds
 *                                  none of it. Not decided; REPORTED as a skip.
 *                                  Does not occur in this repo.
 *
 * The line between the two halves is whether a single file's parse settles it.
 * Everything below it is NAMED in the SKIPPED report rather than counted clean,
 * because a blind spot you can see is a different object from one you cannot.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  ".next",
  ".turbo",
  "coverage",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(full);
    } else if (/\.test\.tsx?$/.test(entry.name)) {
      yield full;
    }
  }
}

function* nodesOf(node) {
  yield node;
  for (const child of node.getChildren()) yield* nodesOf(child);
}

/** The `vi.mock` / `vi.doMock` calls on "@oxagen/database" in this file. */
export function databaseMockCalls(sourceFile) {
  const out = [];
  for (const node of nodesOf(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = node.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      (callee.name.text !== "mock" && callee.name.text !== "doMock") ||
      !ts.isIdentifier(callee.expression) ||
      callee.expression.text !== "vi"
    ) {
      continue;
    }
    const [spec, factory] = node.arguments;
    if (spec === undefined || !ts.isStringLiteral(spec)) continue;
    if (spec.text !== "@oxagen/database") continue;
    if (factory === undefined) continue;
    out.push(factory);
  }
  return out;
}

/**
 * The STATIC name a member of an object literal binds, or null when it binds
 * none that a parse can read.
 *
 * `{ withOrgDb: f }`, `{ "withOrgDb": f }`, `{ ["withOrgDb"]: f }`,
 * ``{ [`withOrgDb`]: f }``, `{ withOrgDb }`, `{ withOrgDb() {} }` and
 * `{ get withOrgDb() {} }` all bind the same name and are all read here. A set
 * accessor binds no readable value and is deliberately excluded (see the header).
 *
 * A bare template key is not a form — ``{ `withOrgDb`: f }`` parses as a tagged
 * template, not a property. The `NoSubstitutionTemplateLiteral` branch below is
 * there because TypeScript's `PropertyName` union carries the node kind, not
 * because an object literal can be written that way.
 */
function staticName(member) {
  if (ts.isShorthandPropertyAssignment(member)) return member.name.text;
  if (ts.isSetAccessorDeclaration(member)) return null;
  if (
    !ts.isPropertyAssignment(member) &&
    !ts.isMethodDeclaration(member) &&
    !ts.isGetAccessorDeclaration(member)
  ) {
    return null;
  }
  const key = member.name;
  if (key === undefined) return null;
  if (ts.isIdentifier(key)) return key.text;
  if (ts.isStringLiteral(key) || ts.isNoSubstitutionTemplateLiteral(key)) {
    return key.text;
  }
  if (ts.isComputedPropertyName(key)) {
    const e = key.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return e.text;
    }
    // `{ [key]: f }` — needs dataflow. Undecidable, and reported as such.
    return null;
  }
  return null;
}

/** True when `expr` is `importOriginal(…)` or `await importOriginal(…)`. */
function isImportOriginalCall(expr) {
  let e = expr;
  // `(await importOriginal())`, `await (importOriginal())`, either nesting.
  while (ts.isAwaitExpression(e) || ts.isParenthesizedExpression(e)) {
    e = e.expression;
  }
  if (!ts.isCallExpression(e)) return false;
  const callee = e.expression;
  return ts.isIdentifier(callee) && callee.text === "importOriginal";
}

/**
 * The object literal a same-file `const` is bound to, or a marker saying why
 * it could not be read. One hop; the caller recurses.
 *
 * `{ real: true }` means "this is the untouched module" — `importOriginal()`.
 * It contributes no substitution, and is not an unknown: it is by construction
 * the thing that leaves `withOrgDb` REAL.
 */
function resolveSpreadTarget(expr, sourceFile) {
  while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
  if (isImportOriginalCall(expr)) return { real: true };
  if (ts.isObjectLiteralExpression(expr)) return { object: expr };
  if (!ts.isIdentifier(expr)) return { unknown: expr.getText(sourceFile) };
  const name = expr.text;
  const decls = [];
  for (const node of nodesOf(sourceFile)) {
    if (!ts.isVariableDeclaration(node)) continue;
    if (!ts.isIdentifier(node.name) || node.name.text !== name) continue;
    decls.push(node);
  }
  // Two bindings of one name is a scope question, which is a dataflow question.
  if (decls.length !== 1) return { unknown: name };
  const init = decls[0].initializer;
  if (init === undefined) return { unknown: name };
  if (isImportOriginalCall(init)) return { real: true };
  if (ts.isObjectLiteralExpression(init)) return { object: init };
  return { unknown: name };
}

/**
 * Does `obj` bind `name`?
 *
 * Returns `{ yes, undecided }`. `undecided` is true when the literal carries a
 * member this parse cannot read — a non-literal computed key, or a spread of
 * something that is neither a same-file object literal nor `importOriginal()`.
 * The caller reports those rather than counting them clean, because the whole
 * failure this file exists to stop is a clean report over an unseen case.
 */
export function assigns(obj, name, sourceFile, seen = new Set()) {
  if (seen.has(obj)) return { yes: false, undecided: false };
  seen.add(obj);
  let undecided = false;
  for (const member of obj.properties) {
    if (ts.isSpreadAssignment(member)) {
      const target = resolveSpreadTarget(member.expression, sourceFile);
      if (target.real === true) continue;
      if (target.object !== undefined) {
        const inner = assigns(target.object, name, sourceFile, seen);
        if (inner.yes) return { yes: true, undecided: false };
        undecided = undecided || inner.undecided;
        continue;
      }
      undecided = true;
      continue;
    }
    const bound = staticName(member);
    if (bound === name) return { yes: true, undecided: false };
    if (bound === null) undecided = true;
  }
  return { yes: false, undecided };
}

/** The function-like node a return statement belongs to, or undefined. */
function enclosingFunction(node) {
  for (let n = node.parent; n !== undefined; n = n.parent) {
    if (ts.isFunctionLike(n)) return n;
  }
  return undefined;
}

/**
 * The object literals a factory RETURNS as its own value — not the ones the
 * fake query builders inside it return. A factory's mock surface is the former;
 * the 300-odd `return Object.assign(Promise.resolve(rows), chain)` lines in this
 * repo are the latter, and reporting those as undecidable would bury the report
 * that matters.
 */
function ownReturnExpressions(factory) {
  const out = [];
  if (
    ts.isArrowFunction(factory) &&
    factory.body !== undefined &&
    !ts.isBlock(factory.body)
  ) {
    const body = ts.isParenthesizedExpression(factory.body)
      ? factory.body.expression
      : factory.body;
    out.push({ node: factory.body, expr: body, concise: true });
    return out;
  }
  for (const node of nodesOf(factory)) {
    if (!ts.isReturnStatement(node)) continue;
    if (enclosingFunction(node) !== factory) continue;
    if (node.expression === undefined) continue;
    out.push({ node, expr: node.expression, concise: false });
  }
  return out;
}

/**
 * The factory returns that carry `withTenantDb` and not yet `withOrgDb`, plus
 * the ones this parse could not decide.
 *
 * A concise arrow body (`() => ({ … })`) has no statement to bind a const in,
 * so it is wrapped in a block rather than guessed at.
 */
function rewritableReturns(factory, sourceFile) {
  const hits = [];
  const skips = [];
  // `vi.mock("@oxagen/database", factoryDefinedElsewhere)` — the second argument
  // is a reference, not a literal function, so this file's parse holds none of
  // the mock. Named, not counted clean. Does not occur in this repo.
  if (!ts.isFunctionLike(factory)) {
    skips.push(
      `a mock factory this check cannot read (${ts.SyntaxKind[factory.kind]}) — it is a reference, not a function written here`,
    );
    return { hits, skips };
  }
  for (const { node, expr, concise } of ownReturnExpressions(factory)) {
    if (!ts.isObjectLiteralExpression(expr)) {
      // Object.assign(…), a conditional, a call — a mock surface this parse
      // does not read. Named, not counted clean. Only worth saying when the
      // factory is about the seam at all.
      if (factory.getText(sourceFile).includes("withTenantDb")) {
        skips.push(
          `a factory return this check cannot read (${ts.SyntaxKind[expr.kind]}) in a factory that mentions withTenantDb`,
        );
      }
      continue;
    }
    const tenant = assigns(expr, "withTenantDb", sourceFile);
    const org = assigns(expr, "withOrgDb", sourceFile);
    if (!tenant.yes) {
      if (tenant.undecided && !org.yes) {
        skips.push(
          "a returned literal carrying a member this check cannot read (a non-literal computed key, or a spread of something that is neither a same-file object literal nor importOriginal())",
        );
      }
      continue;
    }
    if (org.yes) continue;
    if (org.undecided) {
      skips.push(
        "a returned literal that substitutes withTenantDb and may or may not substitute withOrgDb through a member this check cannot read",
      );
      continue;
    }
    hits.push({ statement: node, object: expr, concise });
  }
  return { hits, skips };
}

const INDENT = /^[ \t]*/;

export function rewrite(text, sourceFile) {
  const factories = databaseMockCalls(sourceFile);
  const edits = [];
  const skips = [];
  for (const factory of factories) {
    const { hits, skips: s } = rewritableReturns(factory, sourceFile);
    skips.push(...s);
    for (const hit of hits) edits.push(hit);
  }
  if (edits.length === 0) return { text, changed: 0, skips };

  // Apply back to front so earlier offsets stay valid.
  edits.sort((a, b) => b.statement.getStart() - a.statement.getStart());
  let out = text;
  for (const { statement, object, concise } of edits) {
    const start = statement.getStart(sourceFile);
    const end = statement.getEnd();
    const lineStart = out.lastIndexOf("\n", start) + 1;
    const indent = INDENT.exec(out.slice(lineStart, start))?.[0] ?? "";
    const body = INDENT.test(indent) ? `${indent}  ` : "  ";
    const objectText = out.slice(object.getStart(sourceFile), object.getEnd());
    const note =
      `// The org-wide seam is mocked as the SAME function as the tenant\n` +
      `${concise ? body : indent}// seam (ADR-086): a handler's role gate reads through withOrgDb, and\n` +
      `${concise ? body : indent}// a suite that counts seam calls must see one identity, not two.`;
    const replacement = concise
      ? `{\n${body}${note}\n${body}const dbMock = ${objectText};\n` +
        `${body}return { ...dbMock, withOrgDb: dbMock.withTenantDb };\n${indent}}`
      : `${note}\n${indent}const dbMock = ${objectText};\n` +
        `${indent}return { ...dbMock, withOrgDb: dbMock.withTenantDb };`;
    out = out.slice(0, start) + replacement + out.slice(end);
  }
  return { text: out, changed: edits.length, skips };
}

export function main() {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const roots = args.filter((a) => !a.startsWith("--"));
  const targets =
    roots.length > 0
      ? roots.map((r) => resolve(ROOT, r))
      : [join(ROOT, "apps"), join(ROOT, "packages")];

  let files = 0;
  let changed = 0;
  const skipped = [];
  /** The offending files, so the failure names them instead of counting them. */
  const offenders = [];
  for (const target of targets) {
    for (const file of walk(target)) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("@oxagen/database")) continue;
      if (!text.includes("withTenantDb")) continue;
      const sourceFile = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const result = rewrite(text, sourceFile);
      if (result.skips.length > 0) {
        skipped.push(
          `${file.slice(ROOT.length + 1)} — ${result.skips.join(", ")}`,
        );
      }
      if (result.changed === 0) continue;
      files += 1;
      changed += result.changed;
      offenders.push(`${file.slice(ROOT.length + 1)} (${result.changed})`);
      if (write) writeFileSync(file, result.text, "utf8");
    }
  }
  if (skipped.length > 0) {
    console.log(`SKIPPED — rewrite by hand:\n  ${skipped.join("\n  ")}`);
  }
  if (write) {
    console.log(
      `rewrote ${changed} mock factory return(s) across ${files} file(s)`,
    );
    return;
  }
  if (changed === 0) {
    console.log(
      "check:db-mock-seams — every vi.mock of @oxagen/database that substitutes withTenantDb also substitutes withOrgDb",
    );
    return;
  }
  console.error(
    `check:db-mock-seams — ${changed} vi.mock factory return(s) in ${files} file(s) substitute withTenantDb and leave withOrgDb REAL.\n` +
      "A handler's role gate reads through withOrgDb (ADR-086), so those suites will raise TenantScopeError the moment the module under test authorizes.\n" +
      `  ${offenders.join("\n  ")}\n` +
      "Fix: node tools/scripts/codemod-db-mock-org-seam.mjs --write",
  );
  process.exit(1);
}

// Run only as a script — a test importing the module must not walk the repo.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
