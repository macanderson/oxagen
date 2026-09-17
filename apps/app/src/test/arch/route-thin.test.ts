// INV-24 (ARCHITECTURE.md §2, §4): a route.ts is a one-line delegation. Every
// src/app/**/route.ts holds only imports, re-exports, Next's segment config
// constants with literal values, and exported handlers whose whole body is one
// call to an imported function taking the handler's own values: identifiers,
// or an object of identifiers.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { lineOf, listFiles, parse, readSource, type SourceText } from "./parse";

const RULE = "route-thin";
const PROBES = "src/test/arch/probes/route-thin";

/** Next.js route segment config exports (a literal each). */
const SEGMENT_CONFIG: ReadonlySet<string> = new Set([
  "dynamic",
  "dynamicParams",
  "revalidate",
  "fetchCache",
  "runtime",
  "preferredRegion",
  "maxDuration",
]);

function importedNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    const clause = ts.isImportDeclaration(statement)
      ? statement.importClause
      : undefined;
    if (clause === undefined) continue;
    if (clause.name) names.add(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      names.add(bindings.name.text);
    } else if (bindings) {
      for (const element of bindings.elements) names.add(element.name.text);
    }
  }
  return names;
}

function isThinArgument(argument: ts.Expression): boolean {
  if (ts.isIdentifier(argument)) return true;
  return (
    ts.isObjectLiteralExpression(argument) &&
    argument.properties.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          ts.isIdentifier(property.initializer)),
    )
  );
}

function isDelegation(
  expression: ts.Expression,
  imported: ReadonlySet<string>,
): boolean {
  return (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    imported.has(expression.expression.text) &&
    expression.arguments.every(isThinArgument)
  );
}

function isThinBody(
  body: ts.ConciseBody,
  imported: ReadonlySet<string>,
): boolean {
  if (!ts.isBlock(body)) return isDelegation(body, imported);
  const [only, ...rest] = body.statements;
  return (
    rest.length === 0 &&
    only !== undefined &&
    ts.isReturnStatement(only) &&
    only.expression !== undefined &&
    isDelegation(only.expression, imported)
  );
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function isSegmentLiteral(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isThinDeclaration(
  declaration: ts.VariableDeclaration,
  imported: ReadonlySet<string>,
): boolean {
  const init = declaration.initializer;
  if (init === undefined) return false;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
    return isThinBody(init.body, imported);
  }
  return (
    ts.isIdentifier(declaration.name) &&
    SEGMENT_CONFIG.has(declaration.name.text) &&
    isSegmentLiteral(init)
  );
}

function routeViolations(source: SourceText): string[] {
  const sf = parse(source);
  const imported = importedNames(sf);
  const violations: string[] = [];
  const fail = (node: ts.Node, what: string) => {
    violations.push(
      `${RULE} ${source.file}:${String(lineOf(sf, node))} ${what}`,
    );
  };
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) continue;
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
      continue;
    }
    if (
      ts.isFunctionDeclaration(statement) &&
      isExported(statement) &&
      statement.body
    ) {
      if (!isThinBody(statement.body, imported)) {
        fail(statement, `handler:${statement.name?.text ?? "default"}`);
      }
      continue;
    }
    if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!isThinDeclaration(declaration, imported)) {
          fail(declaration, `export:${declaration.name.getText(sf)}`);
        }
      }
      continue;
    }
    fail(statement, "statement");
  }
  return violations;
}

const probe = (name: string): string[] =>
  routeViolations(readSource(`${PROBES}/${name}`));

describe("route-thin", () => {
  it("every route.ts under src/app is a one-line delegation", () => {
    const routes = listFiles("src/app").filter((file) =>
      file.endsWith("/route.ts"),
    );
    expect(routes.length).toBeGreaterThan(0);
    expect(routes.flatMap((file) => routeViolations(readSource(file)))).toEqual(
      [],
    );
  });

  it.each(["delegating.ts", "arrow.ts", "reexport.ts", "segment-config.ts"])(
    "%s passes",
    (name) => {
      expect(probe(name)).toEqual([]);
    },
  );

  it("a fat route.ts fails: a handler with more than the delegation", () => {
    expect(probe("fat.ts")).toEqual([`${RULE} ${PROBES}/fat.ts:3 handler:GET`]);
  });

  it("a route.ts with a local helper fails", () => {
    expect(probe("local-helper.ts")).toEqual([
      `${RULE} ${PROBES}/local-helper.ts:3 statement`,
    ]);
  });

  it("a handler computing an argument fails", () => {
    expect(probe("computed-argument.ts")).toEqual([
      `${RULE} ${PROBES}/computed-argument.ts:3 export:GET`,
    ]);
  });

  it("a handler calling something it did not import fails", () => {
    expect(probe("unimported.ts")).toEqual([
      `${RULE} ${PROBES}/unimported.ts:3 export:GET`,
    ]);
  });

  it("a segment config export with a computed value fails", () => {
    expect(probe("computed-config.ts")).toEqual([
      `${RULE} ${PROBES}/computed-config.ts:3 export:maxDuration`,
    ]);
  });
});
