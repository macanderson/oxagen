// Shared machinery for the architecture tests in this directory (ARCHITECTURE.md
// §4): file enumeration with fs.readdir (never fd or rg: the CI image carries
// them, a developer machine may not), parsing with the `typescript` compiler API
// (TS 7 exposes none), import-edge extraction, alias resolution and the
// shrink-only baseline.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** apps/app, the directory every path in this harness is relative to. */
export const APP_DIR = fileURLToPath(new URL("../../..", import.meta.url));

export type SourceText = {
  /** Posix path relative to APP_DIR, e.g. `src/ui/money.tsx`. */
  readonly file: string;
  readonly text: string;
};

export type ImportEdge = {
  readonly specifier: string;
  /** 1-based line of the module specifier (a multi-line import is reported where its string sits). */
  readonly line: number;
  /** Imported bindings; `"*"` stands for the whole module (namespace, `export *`, an undestructured `import()`). */
  readonly names: readonly string[];
  /** `import type`, `export type … from`, or every specifier `type`-qualified. */
  readonly typeOnly: boolean;
  /** `import(<non-literal>)`: the target cannot be known statically. */
  readonly computed: boolean;
};

const TS_EXTENSIONS = [".ts", ".tsx"] as const;
/** Imports of these are assets, not modules of any layer. */
const ASSET_EXTENSIONS = [".css", ".json", ".svg", ".png", ".ico"] as const;

/** Every file under `dir` (recursive, via fs.readdir) as posix paths relative to APP_DIR. */
export function listFiles(dir: string): string[] {
  const abs = path.join(APP_DIR, dir);
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(APP_DIR, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    )
    .sort();
}

/** Test-only modules: never in a production bundle, exempt as importers (§4 preamble, INV-22). */
function isTestOnly(file: string): boolean {
  return (
    file.startsWith("src/test/") ||
    /\.(test|type-test|builders|stories)\.tsx?$/.test(file) ||
    file.endsWith(".d.ts") ||
    file === "src/server/viewer.testing.ts"
  );
}

/** The production modules the import graph is checked over: `src/**` plus `instrumentation.ts` (§2). */
export function productionFiles(): string[] {
  const src = listFiles("src").filter(
    (file) =>
      TS_EXTENSIONS.some((ext) => file.endsWith(ext)) && !isTestOnly(file),
  );
  return [...src, "instrumentation.ts"];
}

export function readSource(file: string): SourceText {
  return { file, text: ts.sys.readFile(path.join(APP_DIR, file)) ?? "" };
}

export function parse(source: SourceText): ts.SourceFile {
  const kind = source.file.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    kind,
  );
}

/** The module-level `"use client"` / `"use server"` directive, if any. */
export function directiveOf(
  sf: ts.SourceFile,
): "use client" | "use server" | null {
  for (const statement of sf.statements) {
    if (
      !ts.isExpressionStatement(statement) ||
      !ts.isStringLiteral(statement.expression)
    ) {
      break;
    }
    const text = statement.expression.text;
    if (text === "use client" || text === "use server") return text;
  }
  return null;
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function bindingNames(pattern: ts.ObjectBindingPattern): string[] {
  return pattern.elements.map((element) => {
    const source = element.propertyName ?? element.name;
    return ts.isIdentifier(source) ? source.text : "*";
  });
}

/** The bindings an awaited `import()` is destructured into, or `"*"` for any other use. */
function dynamicImportNames(call: ts.CallExpression): string[] {
  const awaited = call.parent;
  if (!ts.isAwaitExpression(awaited)) return ["*"];
  const declaration = awaited.parent;
  if (
    ts.isVariableDeclaration(declaration) &&
    ts.isObjectBindingPattern(declaration.name)
  ) {
    return bindingNames(declaration.name);
  }
  return ["*"];
}

/** Static imports, `export … from`, dynamic `import()` and `import("x")` type references, in source order. */
export function importEdges(sf: ts.SourceFile): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.importClause;
      const names: string[] = [];
      let allTyped = clause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (clause?.name) names.push("default");
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          names.push("*");
        } else {
          const elements = clause.namedBindings.elements;
          names.push(...elements.map((e) => (e.propertyName ?? e.name).text));
          allTyped ||=
            !clause.name &&
            elements.length > 0 &&
            elements.every((e) => e.isTypeOnly);
        }
      }
      edges.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(sf, node.moduleSpecifier),
        names,
        typeOnly: allTyped,
        computed: false,
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const clause = node.exportClause;
      let names: string[] = ["*"];
      let allTyped = node.isTypeOnly;
      if (clause && ts.isNamedExports(clause)) {
        names = clause.elements.map((e) => (e.propertyName ?? e.name).text);
        allTyped ||=
          clause.elements.length > 0 &&
          clause.elements.every((e) => e.isTypeOnly);
      }
      edges.push({
        specifier: node.moduleSpecifier.text,
        line: lineOf(sf, node.moduleSpecifier),
        names,
        typeOnly: allTyped,
        computed: false,
      });
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      const literal =
        argument &&
        (ts.isStringLiteral(argument) ||
          ts.isNoSubstitutionTemplateLiteral(argument))
          ? argument.text
          : null;
      edges.push({
        specifier: literal ?? "<computed>",
        line: lineOf(sf, argument ?? node),
        names: dynamicImportNames(node),
        typeOnly: false,
        computed: literal === null,
      });
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    ) {
      edges.push({
        specifier: node.argument.literal.text,
        line: lineOf(sf, node.argument),
        names: ["*"],
        typeOnly: true,
        computed: false,
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return edges;
}

export type InternalTarget =
  /** A module under `src/`, as a posix path relative to `src/` without extension; a directory import ends in `/index`. */
  | { readonly kind: "module"; readonly path: string }
  /** A relative import that leaves `src/` (e2e, messages, the app root). */
  | { readonly kind: "outside"; readonly path: string };

/**
 * Where an `@/` or relative specifier points, without touching the file system
 * beyond a directory check: an unresolvable path is tsc's finding, not this
 * test's, so the logical path is judged as spelled.
 */
export function resolveInternal(
  fromFile: string,
  specifier: string,
): InternalTarget | null {
  if (ASSET_EXTENSIONS.some((ext) => specifier.endsWith(ext))) return null;
  let logical: string;
  if (specifier.startsWith("@/")) {
    logical = specifier.slice(2);
  } else if (specifier.startsWith(".")) {
    const fromDir = path.posix.dirname(fromFile.replace(/^src\//, ""));
    logical = path.posix.normalize(path.posix.join(fromDir, specifier));
  } else {
    return null;
  }
  logical = logical.replace(/\.(ts|tsx|js|jsx)$/, "");
  if (logical.startsWith("../") || !fromFile.startsWith("src/")) {
    return { kind: "outside", path: logical };
  }
  if (isDirectory(path.join(APP_DIR, "src", logical))) {
    logical = `${logical}/index`;
  }
  return { kind: "module", path: logical };
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

// --- Baseline ---------------------------------------------------------------
//
// baseline.json is a sorted array of strings, one per violation that existed
// when its rule landed: `<rule> <file>[:<line>] <detail>`. A test computes
// today's violations, keeps the baseline entries of its own rules and demands
// set equality: a violation outside the baseline fails, and so does an entry
// that no longer occurs, so the file can only shrink.

export type BaselineDiff = {
  readonly unexpected: readonly string[];
  readonly stale: readonly string[];
};

export function ruleOf(entry: string): string {
  return entry.split(" ", 1)[0] ?? "";
}

const BASELINE_FILE = fileURLToPath(
  new URL("./baseline.json", import.meta.url),
);

/** Every rule an arch test owns; an entry under any other prefix would never be compared and never go stale. */
const KNOWN_RULES: ReadonlySet<string> = new Set([
  "layer",
  "platform",
  "client",
  "route-guard",
]);

/** The entries of a baseline.json text; throws on a shape or rule prefix no test owns. */
export function parseBaseline(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error("baseline.json must be an array of strings");
  }
  const unknown = parsed.filter((entry) => !KNOWN_RULES.has(ruleOf(entry)));
  if (unknown.length > 0) {
    throw new Error(
      `baseline.json entries under no rule: ${unknown.join(", ")}`,
    );
  }
  return parsed;
}

export function baselineEntries(rules: readonly string[]): string[] {
  return parseBaseline(readFileSync(BASELINE_FILE, "utf8")).filter((entry) =>
    rules.includes(ruleOf(entry)),
  );
}

/** Multiset comparison, so two identical entries (one line, two identical `import()` calls) both stay accounted for. */
export function diffBaseline(
  actual: readonly string[],
  expected: readonly string[],
): BaselineDiff {
  const remaining = [...expected];
  const unexpected: string[] = [];
  for (const entry of actual) {
    const at = remaining.indexOf(entry);
    if (at === -1) unexpected.push(entry);
    else remaining.splice(at, 1);
  }
  return { unexpected: unexpected.sort(), stale: remaining.sort() };
}

export function describeDiff(
  diff: BaselineDiff,
  actual: readonly string[],
): string {
  const lines: string[] = [];
  if (diff.unexpected.length > 0) {
    lines.push(
      "New violations (fix them; a baseline only shrinks):",
      ...diff.unexpected.map((entry) => `  + ${entry}`),
    );
  }
  if (diff.stale.length > 0) {
    lines.push(
      "Baseline entries that no longer occur (delete them from baseline.json):",
      ...diff.stale.map((entry) => `  - ${entry}`),
    );
  }
  lines.push(
    "Today's entries for these rules, sorted:",
    JSON.stringify([...actual].sort(), null, 2),
  );
  return lines.join("\n");
}
