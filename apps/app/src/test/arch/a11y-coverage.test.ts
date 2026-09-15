// INV-26 (ARCHITECTURE.md §4): every src/features/**/*.test.tsx that renders a
// section calls the shared expectNoAxe helper. A test renders a section when
// it calls `render` imported from @testing-library/react; it is covered when
// it calls `expectNoAxe` imported from @/test/expect-no-axe, so a local
// stand-in of the same name does not count.
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { listFiles, parse, readSource, type SourceText } from "./parse";

const RULE = "a11y-coverage";
const PROBES = "src/test/arch/probes/a11y-coverage";

/** The local name `imported` is bound to from `specifier`, if the module imports it. */
function localName(
  sf: ts.SourceFile,
  specifier: string,
  imported: string,
): string | null {
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== specifier
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) continue;
    const element = bindings.elements.find(
      (e) => (e.propertyName ?? e.name).text === imported,
    );
    if (element) return element.name.text;
  }
  return null;
}

function calls(node: ts.Node, name: string | null): boolean {
  if (name === null) return false;
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

function coverageViolations(source: SourceText): string[] {
  const sf = parse(source);
  const renders = calls(sf, localName(sf, "@testing-library/react", "render"));
  const checked = calls(
    sf,
    localName(sf, "@/test/expect-no-axe", "expectNoAxe"),
  );
  return renders && !checked ? [`${RULE} ${source.file} no-expect-no-axe`] : [];
}

const probe = (name: string): string[] =>
  coverageViolations(readSource(`${PROBES}/${name}`));

describe("a11y coverage", () => {
  it("every section test under src/features calls expectNoAxe", () => {
    const tests = listFiles("src/features").filter((file) =>
      file.endsWith(".test.tsx"),
    );
    expect(tests.length).toBeGreaterThan(0);
    expect(
      tests.flatMap((file) => coverageViolations(readSource(file))),
    ).toEqual([]);
  });

  it("a section test with expectNoAxe passes, and so does a test that renders nothing", () => {
    expect(probe("checked.test.tsx")).toEqual([]);
    expect(probe("no-render.test.tsx")).toEqual([]);
  });

  it("a section test without expectNoAxe fails", () => {
    expect(probe("unchecked.test.tsx")).toEqual([
      `${RULE} ${PROBES}/unchecked.test.tsx no-expect-no-axe`,
    ]);
  });

  it("a local expectNoAxe that is not the shared helper does not count", () => {
    expect(probe("local-helper.test.tsx")).toEqual([
      `${RULE} ${PROBES}/local-helper.test.tsx no-expect-no-axe`,
    ]);
  });
});
