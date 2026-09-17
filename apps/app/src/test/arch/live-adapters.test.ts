// INV-06 (ARCHITECTURE.md §3.3, §4): a live read exists only on top of a
// registered contract. Every src/data/live/*.ts module but the composition
// index exports port objects typed `DataSource["<port>"]`, and every method of
// each calls `kernelRead` imported from @/server/kernel. Module-private helpers
// are free; an export that is not a port, or a module with no port, fails.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  isTestOnly,
  lineOf,
  listFiles,
  parse,
  readSource,
  type SourceText,
} from "./parse";

const RULE = "live-adapters";
const LIVE_DIR = "src/data/live/";
const LIVE_INDEX = "src/data/live/index.ts";
const PROBES = "src/test/arch/probes/live-adapters";

function liveFiles(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      file.startsWith(LIVE_DIR) &&
      !file.slice(LIVE_DIR.length).includes("/") &&
      file.endsWith(".ts") &&
      file !== LIVE_INDEX &&
      !isTestOnly(file),
  );
}

/** The local name `kernelRead` is imported under from the kernel seam, if it is. */
function kernelReadName(sf: ts.SourceFile): string | null {
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@/server/kernel"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find(
      (e) => (e.propertyName ?? e.name).text === "kernelRead",
    );
    if (element) return element.name.text;
  }
  return null;
}

/** The port a declaration is typed as, `DataSource["<port>"]`, or null. */
function portOf(declaration: ts.VariableDeclaration): string | null {
  const type = declaration.type;
  if (
    type === undefined ||
    !ts.isIndexedAccessTypeNode(type) ||
    !ts.isTypeReferenceNode(type.objectType) ||
    !ts.isIdentifier(type.objectType.typeName) ||
    type.objectType.typeName.text !== "DataSource" ||
    !ts.isLiteralTypeNode(type.indexType) ||
    !ts.isStringLiteral(type.indexType.literal)
  ) {
    return null;
  }
  return type.indexType.literal.text;
}

function calls(node: ts.Node, name: string): boolean {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === name
  ) {
    return true;
  }
  return (
    ts.forEachChild(node, (child) => calls(child, name) || undefined) ?? false
  );
}

/** The body of an object member that is a method, or null. */
function methodBody(member: ts.ObjectLiteralElementLike): ts.Node | null {
  if (ts.isMethodDeclaration(member)) return member.body ?? null;
  if (
    ts.isPropertyAssignment(member) &&
    (ts.isArrowFunction(member.initializer) ||
      ts.isFunctionExpression(member.initializer))
  ) {
    return member.initializer.body;
  }
  return null;
}

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

function liveAdapterViolations(source: SourceText): string[] {
  const sf = parse(source);
  const kernelRead = kernelReadName(sf);
  const violations: string[] = [];
  const fail = (node: ts.Node, what: string) => {
    violations.push(
      `${RULE} ${source.file}:${String(lineOf(sf, node))} ${what}`,
    );
  };
  let ports = 0;
  for (const statement of sf.statements) {
    if (!isExported(statement)) continue;
    if (!ts.isVariableStatement(statement)) {
      fail(statement, "not-a-port");
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const name = declaration.name.getText(sf);
      const port = portOf(declaration);
      const init = declaration.initializer;
      if (
        port === null ||
        init === undefined ||
        !ts.isObjectLiteralExpression(init)
      ) {
        fail(declaration, `not-a-port:${name}`);
        continue;
      }
      ports += 1;
      for (const member of init.properties) {
        const body = methodBody(member);
        if (body === null || kernelRead === null || !calls(body, kernelRead)) {
          fail(
            member,
            `${port}.${member.name?.getText(sf) ?? "<unnamed>"} no-kernel-read`,
          );
        }
      }
    }
  }
  if (ports === 0) fail(sf, "no-port");
  return violations;
}

const probe = (name: string): string[] =>
  liveAdapterViolations(readSource(`${PROBES}/${name}`));

describe("live adapters", () => {
  it("every port method under src/data/live calls kernelRead", () => {
    const files = liveFiles(listFiles("src"));
    expect(files.length).toBeGreaterThan(0);
    expect(
      files.flatMap((file) => liveAdapterViolations(readSource(file))),
    ).toEqual([]);
  });

  it("a port whose methods call kernelRead passes, with a private helper", () => {
    expect(probe("ok.ts")).toEqual([]);
  });

  it("a live method without kernelRead fails", () => {
    expect(probe("no-kernel-read.ts")).toEqual([
      `${RULE} ${PROBES}/no-kernel-read.ts:6 runs.list no-kernel-read`,
    ]);
  });

  it("a kernelRead that is not the kernel seam's fails", () => {
    expect(probe("local-kernel-read.ts")).toEqual([
      `${RULE} ${PROBES}/local-kernel-read.ts:6 approvals.pending no-kernel-read`,
    ]);
  });

  it("an export that is not typed as a port fails, and so does a module with no port", () => {
    expect(probe("untyped.ts")).toEqual([
      `${RULE} ${PROBES}/untyped.ts:3 not-a-port:org`,
      `${RULE} ${PROBES}/untyped.ts:7 not-a-port`,
      `${RULE} ${PROBES}/untyped.ts:1 no-port`,
    ]);
  });

  it("the composition index, mappers and tests are not port modules (negative)", () => {
    expect(
      liveFiles([
        "src/data/live/index.ts",
        "src/data/live/runs.ts",
        "src/data/live/runs.test.ts",
        "src/data/live/mappers/runs.ts",
        "src/data/ports.ts",
      ]),
    ).toEqual(["src/data/live/runs.ts"]);
  });
});
