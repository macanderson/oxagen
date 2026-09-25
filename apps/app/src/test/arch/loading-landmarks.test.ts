// A route's loading fallback never renders a main landmark. Next renders
// `loading.tsx` as the route segment's Suspense fallback, and while the page
// streams in, the fallback and the page are in the document together. If both
// render `<main id="main">`, the skip link has two targets and page-load's
// strict `main#main` locator fails whenever it looks during the swap. Billing's
// fallback did that on 2026-09-24, and passed or failed depending on timing.
// A `<main>` with no `id` still gives the document two main landmarks, which
// Spend, Runtimes and Fleet did until #4053. The fallback renders a busy
// region. The page owns `main`.
//
// Most `loading.tsx` files re-export a lane's component
// (`export { FleetLoading as default } from "@/features/fleet"`), so the test
// follows that re-export through the lane's barrel, including `export *`, to
// the declaration and checks the component's own source, not only the one-line
// route file. A re-export it cannot follow fails the test rather than passing
// on the route file's text alone.
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  APP_DIR,
  parse,
  productionFiles,
  readSource,
  resolveInternal,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

/** A `<main>` element or an explicit `role="main"`, with or without an `id`. */
const MAIN_LANDMARK = /<main\b|\brole=["{]\s*["']?main["']/;

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

describe("loading fallbacks", () => {
  it(
    "never render a main landmark, which the streamed page owns",
    () => {
      const fallbacks = productionFiles().filter(
        (file) => path.basename(file) === "loading.tsx",
      );
      // An empty list would pass for the wrong reason.
      expect(fallbacks.length).toBeGreaterThan(0);
      const offenders = fallbacks.filter((file) =>
        MAIN_LANDMARK.test(fallbackSource(file)),
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
    expect(MAIN_LANDMARK.test(source)).toBe(true);
    // The route file alone reads clean, which is what the guard missed.
    expect(MAIN_LANDMARK.test(read(route) ?? "")).toBe(false);
  });

  it("fails loudly on a re-export it cannot follow", () => {
    const route = "src/app/[org]/[ws]/lane/loading.tsx";
    const read = memoryTree({
      [route]: 'export { Missing as default } from "@/features/lane";\n',
      "src/features/lane/index.ts": "export const Other = 1;\n",
    });
    expect(() => fallbackSource(route, read)).toThrow(/could not be found/);
  });

  it("catches a fallback that renders main, with or without an id", () => {
    expect(
      MAIN_LANDMARK.test('<main\n      id="main"\n      className="x">'),
    ).toBe(true);
    expect(MAIN_LANDMARK.test('<main\n      aria-busy="true"')).toBe(true);
    expect(MAIN_LANDMARK.test('<section role="main">')).toBe(true);
    expect(MAIN_LANDMARK.test('<div aria-busy="true">')).toBe(false);
    expect(MAIN_LANDMARK.test("<mainline />")).toBe(false);
  });
});
