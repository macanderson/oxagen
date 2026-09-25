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
// follows that re-export through the lane's barrel to the declaration and
// checks the component's own source, not only the one-line route file.
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

/** The module file for a resolved `src/`-relative path, or null. */
function moduleFile(logical: string): string | null {
  for (const ext of [".tsx", ".ts"]) {
    const file = `src/${logical}${ext}`;
    if (ts.sys.fileExists(path.join(APP_DIR, file))) return file;
  }
  return null;
}

/**
 * The source text of the declaration `name` exports from `file`, following
 * `export { a as name } from "..."` re-exports until one declares it. Returns
 * null when the chain leaves `src/` or names nothing.
 */
function declarationSource(
  file: string,
  name: string,
  seen = new Set<string>(),
): string | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const sf = parse(readSource(file));
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
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text !== name) continue;
        const target = resolveInternal(file, statement.moduleSpecifier.text);
        if (target?.kind !== "module") return null;
        const next = moduleFile(target.path);
        if (!next) return null;
        return declarationSource(
          next,
          (element.propertyName ?? element.name).text,
          seen,
        );
      }
    }
  }
  return null;
}

/** What a route's fallback renders: its own file plus a re-exported default component. */
function fallbackSource(file: string): string {
  const own = readSource(file).text;
  const reexported = declarationSource(file, "default");
  return reexported ? `${own}\n${reexported}` : own;
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
