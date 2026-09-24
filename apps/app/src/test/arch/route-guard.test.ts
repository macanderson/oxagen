// INV-01 (ARCHITECTURE.md §4): every page.tsx, layout.tsx and route.ts whose
// path has an [org] segment resolves its viewer with `requireViewer`,
// `resolveViewer` or `resolveWorkspaceViewer` (the workspace layout's form,
// which answers `refused` instead of a 404) imported from
// `src/server/viewer.ts` (§3.1), passing every
// tenant segment it has ([org], then [ws]). A delegating route.ts satisfies it
// when its delegate's deps type requires `resolveViewer` and the delegate's
// unit test carries the non-member 404 negative; the delegate is followed with
// the type checker. A binding with one of those names from any other module
// is `resolver-not-from-viewer`: the name alone proves nothing.
import path from "node:path";
import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";
import {
  APP_DIR,
  baselineEntries,
  describeDiff,
  diffBaseline,
  listFiles,
  productionFiles,
  resolveInternal,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

const RULE = "route-guard";
const VIEWER_RESOLVERS = [
  "requireViewer",
  "resolveViewer",
  "resolveWorkspaceViewer",
] as const;
/** The one module that exports them, as `resolveInternal` spells it. */
const VIEWER_MODULE = "server/viewer";

/** The route modules INV-01 covers. */
function guardedRoutes(files: readonly string[]): string[] {
  return files.filter(
    (file) =>
      file.startsWith("src/app/") &&
      /\/(page\.tsx|layout\.tsx|route\.ts)$/.test(file) &&
      file.split("/").includes("[org]"),
  );
}

/** The tenant segments of a route path, in order: `["org"]` or `["org", "ws"]`. */
function tenantSegments(at: string): string[] {
  return at
    .split("/")
    .map((part) => /^\[(org|ws)\]$/.exec(part)?.[1])
    .filter((seg): seg is string => seg !== undefined);
}

// --- Program ----------------------------------------------------------------
//
// One program over the route files, with a host confined to `src/`: platform
// packages resolve to nothing (their types are not the question), so the
// program stays small and needs no lib.

const toAbs = (file: string): string => path.join(APP_DIR, file);
const toRel = (abs: string): string =>
  path.relative(APP_DIR, abs).split(path.sep).join("/");

function createProgram(roots: readonly string[]): ts.Program {
  const options: ts.CompilerOptions = {
    noEmit: true,
    noLib: true,
    types: [],
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2024,
    jsx: ts.JsxEmit.Preserve,
    strict: true,
    baseUrl: APP_DIR,
    paths: { "@/*": ["src/*"] },
  };
  const base = ts.createCompilerHost(options, true);
  const inside = (abs: string): boolean => toRel(abs).startsWith("src/");
  const host: ts.CompilerHost = {
    ...base,
    fileExists: (abs) => inside(abs) && base.fileExists(abs),
    readFile: (abs) => (inside(abs) ? base.readFile(abs) : undefined),
    directoryExists: (abs) => {
      const rel = toRel(abs);
      return (
        (rel === "" || rel === "src" || rel.startsWith("src/")) &&
        (base.directoryExists?.(abs) ?? false)
      );
    },
  };
  return ts.createProgram(roots.map(toAbs), options, host);
}

// --- Analysis ---------------------------------------------------------------

type Binding = {
  readonly imported: string;
  /** The specifier resolves to `src/server/viewer.ts`. */
  readonly fromViewer: boolean;
};

/** A binding of `requireViewer` / `resolveViewer` taken from the viewer seam. */
function isViewerResolver(binding: Binding | undefined): boolean {
  return (
    binding !== undefined &&
    binding.fromViewer &&
    VIEWER_RESOLVERS.some((name) => name === binding.imported)
  );
}

/** A binding of one of those names taken from anywhere else. */
function isForeignResolver(binding: Binding): boolean {
  return (
    !binding.fromViewer &&
    VIEWER_RESOLVERS.some((name) => name === binding.imported)
  );
}

function importBindings(sf: ts.SourceFile, file: string): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }
    const named = statement.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named)) continue;
    const target = resolveInternal(file, statement.moduleSpecifier.text);
    const fromViewer =
      target?.kind === "module" && target.path === VIEWER_MODULE;
    for (const element of named.elements) {
      bindings.set(element.name.text, {
        imported: (element.propertyName ?? element.name).text,
        fromViewer,
      });
    }
  }
  return bindings;
}

/** `org`, `p.org`, `params["org"]`: the argument names the segment. */
function argumentNames(node: ts.Expression, segment: string): boolean {
  if (ts.isIdentifier(node)) return node.text === segment;
  if (ts.isPropertyAccessExpression(node)) return node.name.text === segment;
  if (ts.isElementAccessExpression(node)) {
    return (
      ts.isStringLiteral(node.argumentExpression) &&
      node.argumentExpression.text === segment
    );
  }
  return false;
}

function collect<T extends ts.Node>(
  root: ts.Node,
  pick: (node: ts.Node) => node is T,
): T[] {
  const found: T[] = [];
  const visit = (node: ts.Node): void => {
    if (pick(node)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/** A direct `await requireViewer(org[, ws])` / `await resolveViewer(…)` with every tenant segment. */
function directCallReasons(
  calls: readonly ts.CallExpression[],
  segments: readonly string[],
): string[] {
  const reasons: string[] = [];
  for (const call of calls) {
    if (!ts.isAwaitExpression(call.parent)) {
      reasons.push("not-awaited");
      continue;
    }
    const missing = segments.find(
      (segment, i) =>
        call.arguments[i] === undefined ||
        !argumentNames(call.arguments[i], segment),
    );
    if (missing === undefined) return [];
    reasons.push(`missing-segment:${missing}`);
  }
  return reasons;
}

/** The sibling unit test of a delegate has an `it`/`test` that mentions `not_found` and `404`. */
function testHasNonMember404(sf: ts.SourceFile): boolean {
  return collect(sf, ts.isCallExpression).some((call) => {
    const callee = call.expression;
    if (!ts.isIdentifier(callee) || !["it", "test"].includes(callee.text)) {
      return false;
    }
    const literals = collect(
      call,
      (n): n is ts.StringLiteral | ts.NumericLiteral =>
        ts.isStringLiteral(n) || ts.isNumericLiteral(n),
    ).map((n) => n.text);
    return literals.includes("not_found") && literals.includes("404");
  });
}

/**
 * A route.ts that hands `resolveViewer` to a delegate: the delegate's deps
 * parameter type must require it, and the delegate's sibling test must carry
 * the non-member 404 negative.
 */
function delegationReasons(
  program: ts.Program,
  sf: ts.SourceFile,
  bindings: ReadonlyMap<string, Binding>,
): string[] | null {
  const checker = program.getTypeChecker();
  const handoffs = collect(sf, ts.isCallExpression).filter((call) =>
    call.arguments.some(
      (argument) =>
        ts.isObjectLiteralExpression(argument) &&
        argument.properties.some((property) => {
          if (ts.isShorthandPropertyAssignment(property)) {
            return isViewerResolver(bindings.get(property.name.text));
          }
          return (
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === "resolveViewer" &&
            ts.isIdentifier(property.initializer) &&
            isViewerResolver(bindings.get(property.initializer.text))
          );
        }),
    ),
  );
  if (handoffs.length === 0) return null;
  const reasons: string[] = [];
  for (const handoff of handoffs) {
    const callee = handoff.expression;
    const symbol = ts.isIdentifier(callee)
      ? checker.getSymbolAtLocation(callee)
      : undefined;
    const target =
      symbol && symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol;
    const declaration = target?.declarations?.find(
      (d): d is ts.FunctionDeclaration => ts.isFunctionDeclaration(d),
    );
    if (
      !declaration ||
      !toRel(declaration.getSourceFile().fileName).startsWith("src/")
    ) {
      reasons.push("delegate-unresolved");
      continue;
    }
    const requires = declaration.parameters.some((parameter) => {
      const property = checker
        .getTypeAtLocation(parameter)
        .getProperty("resolveViewer");
      return (
        property !== undefined && !(property.flags & ts.SymbolFlags.Optional)
      );
    });
    if (!requires) {
      reasons.push("delegate-does-not-require-resolveViewer");
      continue;
    }
    const delegateFile = declaration.getSourceFile().fileName;
    const testFile = delegateFile.replace(/\.tsx?$/, ".test.ts");
    const testText = ts.sys.readFile(testFile);
    if (testText === undefined) {
      reasons.push("delegate-test-missing");
      continue;
    }
    const testSf = ts.createSourceFile(
      testFile,
      testText,
      ts.ScriptTarget.Latest,
      true,
    );
    if (!testHasNonMember404(testSf)) {
      reasons.push("delegate-test-lacks-non-member-404");
      continue;
    }
    return [];
  }
  return reasons;
}

/** Baseline entries for one route module read from `file`, judged as if at `at`. */
function routeGuardViolations(
  program: ts.Program,
  file: string,
  at: string = file,
): string[] {
  const sf = program.getSourceFile(toAbs(file));
  if (!sf) throw new Error(`${file} is not in the program`);
  const segments = tenantSegments(at);
  const bindings = importBindings(sf, file);
  const calls = collect(sf, ts.isCallExpression).filter(
    (call) =>
      ts.isIdentifier(call.expression) &&
      isViewerResolver(bindings.get(call.expression.text)),
  );
  let reasons = directCallReasons(calls, segments);
  if (calls.length > 0 && reasons.length === 0) return [];
  if (at.endsWith("/route.ts")) {
    const delegated = delegationReasons(program, sf, bindings);
    if (delegated !== null) {
      if (delegated.length === 0) return [];
      reasons = [...reasons, ...delegated];
    }
  }
  if (reasons.length === 0 && [...bindings.values()].some(isForeignResolver)) {
    reasons.push("resolver-not-from-viewer");
  }
  return [`${RULE} ${at} ${reasons[0] ?? "no-viewer-call"}`];
}

// --- Tests ------------------------------------------------------------------

const PROBE_DIR = "src/test/arch/probes/route-guard";
/** Each probe route is judged as if it sat at `at`; `expect` is the reason it must fail with, or null. */
const PROBES: Readonly<Record<string, { at: string; expect: string | null }>> =
  {
    "page-no-call/page.tsx": {
      at: "src/app/[org]/probe/page.tsx",
      expect: "no-viewer-call",
    },
    "page-org-only/page.tsx": {
      at: "src/app/[org]/[ws]/probe/page.tsx",
      expect: "missing-segment:ws",
    },
    "page-not-awaited/page.tsx": {
      at: "src/app/[org]/probe/page.tsx",
      expect: "not-awaited",
    },
    "page-ok/page.tsx": {
      at: "src/app/[org]/[ws]/probe/page.tsx",
      expect: null,
    },
    "page-fake-viewer/page.tsx": {
      at: "src/app/[org]/probe/page.tsx",
      expect: "resolver-not-from-viewer",
    },
    "layout-ok/layout.tsx": { at: "src/app/[org]/layout.tsx", expect: null },
    "route-direct-ok/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: null,
    },
    "route-delegate-ok/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: null,
    },
    "route-delegate-optional/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: "delegate-does-not-require-resolveViewer",
    },
    "route-delegate-no-test/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: "delegate-test-missing",
    },
    "route-delegate-no-404/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: "delegate-test-lacks-non-member-404",
    },
    "route-delegate-unresolved/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: "delegate-unresolved",
    },
    "route-delegate-fake-viewer/route.ts": {
      at: "src/app/api/probe/[org]/[ws]/route.ts",
      expect: "resolver-not-from-viewer",
    },
  };

describe("route guard", () => {
  const probeRoutes = Object.keys(PROBES).map(
    (probe) => `${PROBE_DIR}/${probe}`,
  );
  // Enumerating the tree and building the program are the expensive half, so
  // they run in a hook that declares a budget: at `describe` scope they would
  // run during collection, where no timeout governs them (INV-25).
  let routes: string[] = [];
  let program: ts.Program;

  beforeAll(() => {
    routes = guardedRoutes(productionFiles());
    program = createProgram([...routes, ...probeRoutes]);
  }, WHOLE_TREE_TIMEOUT_MS);

  it("covers page, layout and route modules with an [org] segment, under src/app/[org] and src/app/api alike", () => {
    expect(
      guardedRoutes([
        "src/app/[org]/x/page.tsx",
        "src/app/[org]/layout.tsx",
        "src/app/api/mc/[org]/[ws]/stream/route.ts",
        "src/app/login/page.tsx",
        "src/app/[org]/loading.tsx",
        "src/features/[org]/page.tsx",
      ]),
    ).toEqual([
      "src/app/[org]/x/page.tsx",
      "src/app/[org]/layout.tsx",
      "src/app/api/mc/[org]/[ws]/stream/route.ts",
    ]);
  });

  it(
    "today's violations are exactly the baseline",
    () => {
      const actual = routes.flatMap((file) =>
        routeGuardViolations(program, file),
      );
      const diff = diffBaseline(actual, baselineEntries([RULE]));
      expect(diff, describeDiff(diff, actual)).toEqual({
        unexpected: [],
        stale: [],
      });
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("every probe route is placed", () => {
    const routeProbes = listFiles(PROBE_DIR)
      .map((f) => f.slice(PROBE_DIR.length + 1))
      .filter((f) => /\/(page|layout|route)\.tsx?$/.test(f));
    expect(routeProbes).toEqual(Object.keys(PROBES).sort());
  });

  for (const [probe, { at, expect: reason }] of Object.entries(PROBES)) {
    it(`${probe} ${reason === null ? "passes" : `fails ${reason}`}`, () => {
      const violations = routeGuardViolations(
        program,
        `${PROBE_DIR}/${probe}`,
        at,
      );
      expect(violations).toEqual(
        reason === null ? [] : [`${RULE} ${at} ${reason}`],
      );
    });
  }
});
