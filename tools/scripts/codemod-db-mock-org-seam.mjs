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

/** The `vi.mock("@oxagen/database", …)` calls in this file. */
function databaseMockCalls(sourceFile) {
  const out = [];
  for (const node of nodesOf(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    const callee = node.expression;
    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== "mock" ||
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

/** True when the object literal assigns `name` as a plain property. */
function assigns(obj, name) {
  return obj.properties.some(
    (p) =>
      ts.isPropertyAssignment(p) &&
      ts.isIdentifier(p.name) &&
      p.name.text === name,
  );
}

/**
 * The `return <object literal>;` statements inside a factory that carry
 * `withTenantDb` and not yet `withOrgDb`. Only a statement return is rewritten:
 * a concise arrow body (`() => ({ … })`) has no statement to bind a const in,
 * and is reported as a skip rather than guessed at.
 */
function rewritableReturns(factory) {
  const hits = [];
  const skips = [];
  for (const node of nodesOf(factory)) {
    if (ts.isReturnStatement(node)) {
      const expr = node.expression;
      if (expr === undefined || !ts.isObjectLiteralExpression(expr)) continue;
      if (!assigns(expr, "withTenantDb")) continue;
      if (assigns(expr, "withOrgDb")) continue;
      hits.push({ statement: node, object: expr });
      continue;
    }
    // `async () => ({ ...real, withTenantDb: x })` — a concise body, which has
    // no statement to bind a const in. Give it one.
    if (
      ts.isArrowFunction(node) &&
      node.body !== undefined &&
      !ts.isBlock(node.body) &&
      ts.isParenthesizedExpression(node.body) &&
      ts.isObjectLiteralExpression(node.body.expression) &&
      assigns(node.body.expression, "withTenantDb") &&
      !assigns(node.body.expression, "withOrgDb")
    ) {
      hits.push({
        statement: node.body,
        object: node.body.expression,
        concise: true,
      });
    }
  }
  return { hits, skips };
}

const INDENT = /^[ \t]*/;

function rewrite(text, sourceFile) {
  const factories = databaseMockCalls(sourceFile);
  const edits = [];
  const skips = [];
  for (const factory of factories) {
    const { hits, skips: s } = rewritableReturns(factory);
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

function main() {
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
      "Fix: node tools/scripts/codemod-db-mock-org-seam.mjs --write",
  );
  process.exit(1);
}

main();
