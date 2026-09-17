// INV-12 (ARCHITECTURE.md §4): no catalog key goes unused. Every translator a
// production module binds — `useTranslations(ns)` or `await getTranslations(ns)`,
// directly or out of a `Promise.all` — is followed to its calls, and each key
// is expanded with the type checker: a literal, a union-typed value, or a
// template whose spans are unions, so `unrecorded.${section}` expands against
// UNRECORDED's keys and `errors.${key}` against a form's error keys. A key or
// namespace the checker cannot expand to literals fails rather than hiding
// what it reads. `pages.${key}` counts REV1_ROUTES' title keys as read, an
// empty list until e2e/routes.ts lands (WL-47). A module that imports a
// catalog as JSON (global-error.tsx, outside the intl provider) reads the keys
// its property chains name, through a `const` alias too. Then every leaf of
// messages/*.json must be read by some module.
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import { UNRECORDED } from "@/data/unrecorded";
import { loadCatalogs } from "@/i18n/load-catalogs";
import {
  APP_DIR,
  lineOf,
  listFiles,
  productionFiles,
  TYPE_CHECKED_TREE_TIMEOUT_MS,
} from "./parse";

const RULE = "catalog-used";
const PROBES = "src/test/arch/probes/catalog-used";
/** The title keys of REV1_ROUTES in e2e/routes.ts (§6.3), read by page-load.spec.ts; WL-47 lands them. */
const REV1_ROUTE_TITLE_KEYS: readonly string[] = [];
const FACTORIES: ReadonlySet<string> = new Set([
  "useTranslations",
  "getTranslations",
]);
const CATALOG_IMPORT = /(^|\/)messages\/[a-z0-9-]+\.json$/;
const TRANSLATOR_METHODS: ReadonlySet<string> = new Set([
  "rich",
  "markup",
  "raw",
  "has",
]);

type Usage = { readonly used: string[]; readonly violations: string[] };

function leafKeys(messages: Record<string, unknown>, trail = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const at = trail ? `${trail}.${key}` : key;
    return typeof value === "object" && value !== null
      ? leafKeys(Object.fromEntries(Object.entries(value)), at)
      : [at];
  });
}

function unusedKeys(
  keys: readonly string[],
  used: readonly string[],
): string[] {
  return keys
    .filter((key) => !used.some((u) => key === u || key.startsWith(`${u}.`)))
    .map((key) => `${RULE} unused ${key}`);
}

function createProgram(roots: readonly string[]): ts.Program {
  const parsed = ts.getParsedCommandLineOfConfigFile(
    path.join(APP_DIR, "tsconfig.json"),
    {},
    { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined },
  );
  if (parsed === undefined) throw new Error("tsconfig.json is unreadable");
  return ts.createProgram(
    roots.map((file) => path.join(APP_DIR, file)),
    { ...parsed.options, noEmit: true },
  );
}

/** The namespace a translator factory call binds: `""` for none, null when not a literal, undefined when not a factory. */
function factoryNamespace(
  expression: ts.Expression,
): string | null | undefined {
  const call = ts.isAwaitExpression(expression)
    ? expression.expression
    : expression;
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    !FACTORIES.has(call.expression.text)
  ) {
    return undefined;
  }
  const [namespace] = call.arguments;
  if (namespace === undefined) return "";
  return ts.isStringLiteralLike(namespace) ? namespace.text : null;
}

/** The string literals a key argument can be, or null when one part is not a literal. */
function literalsOf(
  checker: ts.TypeChecker,
  expression: ts.Expression,
): string[] | null {
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) {
    let values = [expression.head.text];
    for (const span of expression.templateSpans) {
      const parts = literalsOf(checker, span.expression);
      if (parts === null) return null;
      values = values.flatMap((prefix) =>
        parts.map((part) => `${prefix}${part}${span.literal.text}`),
      );
    }
    return values;
  }
  const type = checker.getTypeAtLocation(expression);
  const values: string[] = [];
  for (const part of type.isUnion() ? type.types : [type]) {
    if (!part.isStringLiteral()) return null;
    values.push(part.value);
  }
  return values;
}

function usageOf(program: ts.Program, files: readonly string[]): Usage {
  const checker = program.getTypeChecker();
  const used: string[] = [];
  const violations: string[] = [];
  for (const file of files) {
    const sf = program.getSourceFile(path.join(APP_DIR, file));
    if (sf === undefined) throw new Error(`${file} is not in the program`);
    const fail = (node: ts.Node, what: string) => {
      violations.push(`${RULE} ${file}:${String(lineOf(sf, node))} ${what}`);
    };
    const namespaces = new Map<ts.Symbol, string>();
    /** A catalog imported as JSON, or a `const` alias of a path into one: symbol → key prefix. */
    const catalogs = new Map<ts.Symbol, string>();
    const aliases = new Set<ts.Node>();
    const chainOf = (expression: ts.Expression): string | null => {
      if (ts.isIdentifier(expression)) {
        const symbol = checker.getSymbolAtLocation(expression);
        return symbol ? (catalogs.get(symbol) ?? null) : null;
      }
      if (!ts.isPropertyAccessExpression(expression)) return null;
      const head = chainOf(expression.expression);
      if (head === null) return null;
      return head ? `${head}.${expression.name.text}` : expression.name.text;
    };
    const bind = (
      name: ts.Identifier,
      namespace: string | null | undefined,
    ) => {
      if (namespace === undefined) return;
      const symbol = checker.getSymbolAtLocation(name);
      if (namespace === null) fail(name, "unreadable-namespace");
      else if (symbol) namespaces.set(symbol, namespace);
    };
    const collect = (node: ts.Node): void => {
      const importedAs = ts.isImportDeclaration(node)
        ? node.importClause?.name
        : undefined;
      if (
        importedAs &&
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        CATALOG_IMPORT.test(node.moduleSpecifier.text)
      ) {
        const symbol = checker.getSymbolAtLocation(importedAs);
        if (symbol) catalogs.set(symbol, "");
      }
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const init = node.initializer;
        const chain = chainOf(init);
        const symbol = checker.getSymbolAtLocation(node.name);
        if (chain !== null && symbol) {
          catalogs.set(symbol, chain);
          aliases.add(init);
        }
        if (ts.isIdentifier(node.name)) {
          bind(node.name, factoryNamespace(init));
        } else if (
          ts.isArrayBindingPattern(node.name) &&
          ts.isAwaitExpression(init) &&
          ts.isCallExpression(init.expression)
        ) {
          const [all] = init.expression.arguments;
          const elements =
            all && ts.isArrayLiteralExpression(all) ? all.elements : [];
          node.name.elements.forEach((element, i) => {
            const source = elements[i];
            if (
              ts.isBindingElement(element) &&
              ts.isIdentifier(element.name) &&
              source
            ) {
              bind(element.name, factoryNamespace(source));
            }
          });
        }
      }
      ts.forEachChild(node, collect);
    };
    const read = (node: ts.Node): void => {
      if (
        ts.isPropertyAccessExpression(node) &&
        !aliases.has(node) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.expression === node
        )
      ) {
        const chain = chainOf(node);
        if (chain) used.push(chain);
      }
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const target =
          ts.isPropertyAccessExpression(callee) &&
          TRANSLATOR_METHODS.has(callee.name.text)
            ? callee.expression
            : callee;
        const symbol = ts.isIdentifier(target)
          ? checker.getSymbolAtLocation(target)
          : undefined;
        const namespace = symbol ? namespaces.get(symbol) : undefined;
        const [key] = node.arguments;
        if (namespace !== undefined && key !== undefined) {
          const keys = literalsOf(checker, key);
          if (keys === null) fail(node, "unexpandable-key");
          else
            used.push(
              ...keys.map((k) => (namespace ? `${namespace}.${k}` : k)),
            );
        }
      }
      ts.forEachChild(node, read);
    };
    collect(sf);
    read(sf);
  }
  return { used, violations: violations.sort() };
}

const PROBE_SOURCES = listFiles(PROBES).filter((file) => /\.tsx?$/.test(file));
// The tree walk and the program share the hook's budget: at module scope they
// would run during collection, where no timeout governs them (INV-25).
let sources: string[] = [];
let program: ts.Program;

beforeAll(() => {
  sources = productionFiles().filter((file) => file.startsWith("src/"));
  program = createProgram([...sources, ...PROBE_SOURCES]);
}, TYPE_CHECKED_TREE_TIMEOUT_MS);

describe("catalog keys", () => {
  it(
    "every key of messages/*.json is read by a production module",
    () => {
      const { used, violations } = usageOf(program, sources);
      expect(violations).toEqual([]);
      const keys = leafKeys(loadCatalogs(path.join(APP_DIR, "messages")));
      expect(unusedKeys(keys, [...used, ...REV1_ROUTE_TITLE_KEYS])).toEqual([]);
    },
    TYPE_CHECKED_TREE_TIMEOUT_MS,
  );

  it("reads every UNRECORDED row through NotRecorded's unrecorded.${section}", () => {
    const { used, violations } = usageOf(program, ["src/ui/not-recorded.tsx"]);
    expect(violations).toEqual([]);
    expect(used).toEqual(
      expect.arrayContaining(
        Object.keys(UNRECORDED).map((key) => `unrecorded.${key}`),
      ),
    );
  });

  it("an unused catalog key fails; literal, union, template, Promise.all and rich reads pass", () => {
    const { used, violations } = usageOf(program, [`${PROBES}/used.tsx`]);
    expect(violations).toEqual([]);
    const keys = leafKeys(loadCatalogs(path.join(APP_DIR, PROBES, "messages")));
    expect(unusedKeys(keys, used)).toEqual([`${RULE} unused app.unused`]);
  });

  it("reads the keys a catalog imported as JSON names, through an alias too", () => {
    const { used, violations } = usageOf(program, [
      `${PROBES}/json-import.tsx`,
    ]);
    expect(violations).toEqual([]);
    expect([...used].sort()).toEqual(["app.name", "panel.title"]);
  });

  it("a key the checker cannot expand fails, and so does a computed namespace", () => {
    expect(usageOf(program, [`${PROBES}/unexpandable.tsx`]).violations).toEqual(
      [
        `${RULE} ${PROBES}/unexpandable.tsx:5 unexpandable-key`,
        `${RULE} ${PROBES}/unexpandable.tsx:9 unreadable-namespace`,
      ],
    );
  });
});
