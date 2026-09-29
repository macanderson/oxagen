// The organization shell renders the page's one main landmark, and nothing
// under it renders another (ADR-227). Next renders a segment's `loading.tsx`
// as its Suspense fallback, and while the page streams in, the fallback and
// the page are in the document together. When each rendered its own
// `<main id="main">`, the skip link had two targets and page-load's strict
// `main#main` locator failed whenever it looked during the swap: Billing on
// 2026-09-24, then Fleet, Spend and Runtimes until #4053. A `main` inside the
// page alone is missing while the fallback shows, so the shell frame owns it,
// above the organization layout's <Suspense>, from the first byte on.
//
// The tree check reads JSX, not text, so a comment that names `<main>` passes
// and an `id="main"` on any element fails: the skip link targets the id.
// Most `loading.tsx` files re-export a lane's component
// (`export { FleetLoading as default } from "@/features/fleet"`), so the
// fallback check follows that re-export through the lane's barrel, including
// `export *`, to the declaration and checks the component's own source, not
// only the one-line route file. A re-export it cannot follow fails the test
// rather than passing on the route file's text alone.
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  APP_DIR,
  parse,
  productionFiles,
  readSource,
  resolveInternal,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

/** The shell frame, which renders the one `main#main` every page sits in. */
const SHELL_FRAME = "src/features/shell/shell-frame.tsx";

/**
 * Every module allowed to render a main landmark. Each one draws a whole
 * document or a frame outside the organization shell, so no two of them are
 * ever in one document.
 */
const LANDMARK_OWNERS = [
  // The root layout's error page, which replaces the whole document.
  "src/app/global-error.tsx",
  // The 404 for an address no route answers, above every organization.
  "src/app/not-found.tsx",
  // The onboarding gate (/new-organization and /welcome/**), outside the shell.
  "src/features/onboarding/ui/gate-shell.tsx",
  // The organization shell, around every organization and workspace page.
  SHELL_FRAME,
  // The sign-in, sign-up and CLI hand-off pages, outside every organization.
  "src/ui/auth-shell.tsx",
];

/** Whether a JSX attribute is `role="main"` or `id="main"`. */
function claimsMain(attribute: ts.JsxAttributeLike): boolean {
  if (!ts.isJsxAttribute(attribute) || !ts.isIdentifier(attribute.name)) {
    return false;
  }
  if (attribute.name.text !== "role" && attribute.name.text !== "id") {
    return false;
  }
  const value = attribute.initializer;
  if (value === undefined) return false;
  if (ts.isStringLiteral(value)) return value.text === "main";
  return (
    ts.isJsxExpression(value) &&
    value.expression !== undefined &&
    ts.isStringLiteralLike(value.expression) &&
    value.expression.text === "main"
  );
}

/**
 * The 1-based lines where a module's JSX renders a main landmark: a `<main>`,
 * a `role="main"`, or an `id="main"`, the skip link's target.
 */
function mainLandmarks(source: SourceText): number[] {
  const sf = parse(source);
  const lines: number[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName;
      if (
        (ts.isIdentifier(tag) && tag.text === "main") ||
        node.attributes.properties.some(claimsMain)
      ) {
        const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
        lines.push(line + 1);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return lines;
}

/**
 * Reads a `src/`-relative source file, or returns null when it does not
 * exist. The tree check reads the disk; the self-tests pass an in-memory tree.
 */
type ReadFile = (file: string) => string | null;

const readDisk: ReadFile = (file) =>
  ts.sys.fileExists(path.join(APP_DIR, file)) ? readSource(file).text : null;

/** The module file for a resolved `src/`-relative path, or null. */
function moduleFile(logical: string, read: ReadFile): string | null {
  for (const candidate of [logical, `${logical}/index`]) {
    for (const ext of [".tsx", ".ts"]) {
      const file = `src/${candidate}${ext}`;
      if (read(file) !== null) return file;
    }
  }
  return null;
}

/** The module file an `@/` or relative specifier in `file` names, or null. */
function targetFile(
  file: string,
  specifier: string,
  read: ReadFile,
): string | null {
  const target = resolveInternal(file, specifier);
  return target?.kind === "module" ? moduleFile(target.path, read) : null;
}

/**
 * The source text of the declaration `name` exports from `file`, following
 * `export { a as name } from "..."` and `export * from "..."` re-exports until
 * one declares it. Returns null when the chain leaves `src/` or names nothing.
 */
function declarationSource(
  file: string,
  name: string,
  read: ReadFile = readDisk,
  seen = new Set<string>(),
): string | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const text = read(file);
  if (text === null) return null;
  const sf = parse({ file, text });
  const starTargets: string[] = [];
  for (const statement of sf.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement.getText(sf);
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name) {
          return decl.getText(sf);
        }
      }
    }
    if (
      !ts.isExportDeclaration(statement) ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    if (!statement.exportClause) {
      // `export * from "..."` never re-exports `default`.
      if (name !== "default") starTargets.push(specifier);
      continue;
    }
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text !== name) continue;
      const next = targetFile(file, specifier, read);
      if (!next) return null;
      return declarationSource(
        next,
        (element.propertyName ?? element.name).text,
        read,
        seen,
      );
    }
  }
  // A local declaration or named re-export wins over `export *`, as in tsc.
  for (const specifier of starTargets) {
    const next = targetFile(file, specifier, read);
    const found = next && declarationSource(next, name, read, seen);
    if (found) return found;
  }
  return null;
}

/** Whether `file` re-exports its default from another module. */
function reexportsDefault(file: string, read: ReadFile): boolean {
  const text = read(file);
  if (text === null) return false;
  return parse({ file, text }).statements.some(
    (statement) =>
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      statement.exportClause !== undefined &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.some((e) => e.name.text === "default"),
  );
}

/**
 * What a route's fallback renders: its own file plus a re-exported default
 * component. A re-export the test cannot follow throws, so a barrel reshaped
 * past the resolver fails the guard instead of silently checking one line.
 */
function fallbackSource(file: string, read: ReadFile = readDisk): string {
  const own = read(file) ?? "";
  const reexported = declarationSource(file, "default", read);
  if (!reexported && reexportsDefault(file, read)) {
    throw new Error(
      `${file} re-exports its default component, and the declaration could not be found`,
    );
  }
  return reexported ? `${own}\n${reexported}` : own;
}

/** A read over an in-memory tree of `src/`-relative files. */
function memoryTree(files: Record<string, string>): ReadFile {
  return (file) => files[file] ?? null;
}

describe("the main landmark", () => {
  it("is rendered once, by the shell frame", () => {
    const frame = readSource(SHELL_FRAME);
    expect(mainLandmarks(frame)).toHaveLength(1);
    expect(frame.text).toContain('<main id="main"');
  });

  it(
    "is rendered by no other module under the shell",
    () => {
      const owners = productionFiles()
        .filter((file) => file.endsWith(".tsx"))
        .filter((file) => mainLandmarks(readSource(file)).length > 0);
      expect(owners).toEqual([...LANDMARK_OWNERS].sort());
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it(
    "is never rendered by a route's loading fallback",
    () => {
      const fallbacks = productionFiles().filter(
        (file) => path.basename(file) === "loading.tsx",
      );
      // An empty list would pass for the wrong reason.
      expect(fallbacks.length).toBeGreaterThan(0);
      const offenders = fallbacks.filter(
        (file) =>
          mainLandmarks({ file, text: fallbackSource(file) }).length > 0,
      );
      expect(offenders).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("follows a route's re-export to the lane component it renders", () => {
    const route = "src/app/[org]/[ws]/(fleet)/loading.tsx";
    const source = declarationSource(route, "default");
    expect(source).toMatch(/^export function FleetLoading\(/);
    expect(source).toContain('aria-busy="true"');
  });

  it("rejects a route whose re-exported lane component renders main", () => {
    const route = "src/app/[org]/[ws]/lane/loading.tsx";
    const read = memoryTree({
      [route]: 'export { LaneLoading as default } from "@/features/lane";\n',
      "src/features/lane/index.ts": 'export * from "./states";\n',
      "src/features/lane/states.tsx":
        'export function LaneLoading() {\n  return <main aria-busy="true" />;\n}\n',
    });
    const source = fallbackSource(route, read);
    expect(source).toContain("export function LaneLoading()");
    expect(mainLandmarks({ file: route, text: source })).toHaveLength(1);
    // The route file alone reads clean, which is what the guard missed.
    expect(mainLandmarks({ file: route, text: read(route) ?? "" })).toEqual(
      [],
    );
  });

  it("fails loudly on a re-export it cannot follow", () => {
    const route = "src/app/[org]/[ws]/lane/loading.tsx";
    const read = memoryTree({
      [route]: 'export { Missing as default } from "@/features/lane";\n',
      "src/features/lane/index.ts": "export const Other = 1;\n",
    });
    expect(() => fallbackSource(route, read)).toThrow(/could not be found/);
  });

  it("counts a main element, role main and id main, and nothing else", () => {
    const lines = (text: string) =>
      mainLandmarks({ file: "src/features/lane/x.tsx", text });
    expect(
      lines('const a = <main\n  id="main"\n  className="x">b</main>;'),
    ).toEqual([1]);
    expect(lines('const a = <main aria-busy="true" />;')).toEqual([1]);
    expect(lines('const a = <section role="main" />;')).toEqual([1]);
    expect(lines('const a = <section role={"main"} />;')).toEqual([1]);
    expect(lines('const a = <div id="main" />;')).toEqual([1]);
    expect(lines('const a = <div aria-busy="true" />;')).toEqual([]);
    expect(lines("const a = <mainline />;")).toEqual([]);
    expect(lines('const a = <a href="#main">Skip</a>;')).toEqual([]);
    // A comment or a string that names the element renders nothing.
    expect(
      lines('// the shell owns <main id="main">\nconst a = "<main>";'),
    ).toEqual([]);
  });
});
