// INV-19 (ARCHITECTURE.md §4): every exported function of a "use server"
// module — selected by the directive, never by the file name — returns
// `Promise<ActionResult<…>>` or `Promise<never>`, reaches `requireViewer`,
// `requireUser` or `requireInvitee` from @/server/viewer (itself or through a
// function of its own module), and never reads an org or workspace id from
// its input or a form field. No action is exempt. The flows that run before
// any session exists (password reset, verification resend) call Better Auth
// from the browser over HTTP, where its rate limiter applies (#4042).
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  directiveOf,
  lineOf,
  parse,
  productionFiles,
  readSource,
  type SourceText,
  WHOLE_TREE_TIMEOUT_MS,
} from "./parse";

/**
 * A source file parsed WITHOUT parent pointers, for the directive scan only.
 *
 * Selecting the `"use server"` modules means reading the first statement of all
 * 293 production files, and `parse` sets `setParentNodes`, which the scan does
 * not need — only `actionViolations` does, on the 11 that survive. Strictly
 * less work for the same answer, which is the whole of the argument.
 *
 * Deliberately NOT claiming a speedup. An earlier revision of this comment
 * cited 460ms with parent pointers against 191ms without, from a single pair
 * run back to back in one process. The first run is cold: repeating the pair
 * five times gives 426/138, 134/88, 120/93, 107/86, 98/68, so that figure
 * measured JIT warm-up as much as the flag, and on another machine the same
 * comparison moved the wrong way on two of four arch tests. At this scale the
 * noise dominates. A single measurement is a reading, not a result.
 *
 * A substring pre-filter on the raw text was tried first and withdrawn — on
 * exactness, not on speed. It is a heuristic in the one direction that
 * matters: too many files selected is harmless, because `directiveOf` rejects
 * them, but a module carrying the directive whose raw text lacks the literal
 * would be skipped SILENTLY and this test would go blind rather than fail.
 * Counting the two sets proves they agree on today's tree and nothing more.
 *
 * That hazard is real but not exploitable, and the reason is worth leaving
 * here: `directiveOf` compares `statement.expression.text`, the COOKED string,
 * so a unicode-escaped space inside the literal satisfies it while the raw
 * source does not contain the substring. ECMAScript defines a directive
 * prologue by raw source characters and the bundler follows that, so such a
 * module is not a server module at runtime either. `directiveOf` is the one
 * out of step, not the pre-filter.
 */
const scan = (source: SourceText): ts.SourceFile =>
  ts.createSourceFile(
    source.file,
    source.text,
    ts.ScriptTarget.Latest,
    false,
    source.file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

const RULE = "actions";
const PROBES = "src/test/arch/probes/actions";
const VIEWER_RESOLVERS: ReadonlySet<string> = new Set([
  "requireViewer",
  "requireUser",
  "requireInvitee",
]);
/** An org or workspace id, however it is spelled. */
const TENANT_ID = /^(org|workspace)_?id$/i;

type Fail = (node: ts.Node, what: string) => void;
type Action = {
  readonly name: string;
  readonly at: ts.Node;
  readonly fn: ts.SignatureDeclaration & { readonly body?: ts.Node };
};

function isExported(statement: ts.Statement): boolean {
  return (
    ts.canHaveModifiers(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

/** Imported name → local name, for the named imports of one specifier. */
function importsFrom(
  sf: ts.SourceFile,
  specifier: string,
): Map<string, string> {
  const names = new Map<string, string>();
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
    for (const element of bindings.elements) {
      names.set((element.propertyName ?? element.name).text, element.name.text);
    }
  }
  return names;
}

/** Function bodies declared at the top of the module, by name. */
function localFunctions(sf: ts.SourceFile): Map<string, ts.Node> {
  const locals = new Map<string, ts.Node>();
  for (const statement of sf.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      statement.body
    ) {
      locals.set(statement.name.text, statement.body);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const init = declaration.initializer;
        if (
          ts.isIdentifier(declaration.name) &&
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          locals.set(declaration.name.text, init.body);
        }
      }
    }
  }
  return locals;
}

function actionsOf(sf: ts.SourceFile, fail: Fail): Action[] {
  const actions: Action[] = [];
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && isExported(statement)) {
      actions.push({
        name: statement.name?.text ?? "default",
        at: statement,
        fn: statement,
      });
    } else if (ts.isVariableStatement(statement) && isExported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const name = declaration.name.getText(sf);
        const init = declaration.initializer;
        if (
          init &&
          (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
        ) {
          actions.push({ name, at: declaration, fn: init });
        } else {
          fail(declaration, `not-an-action:${name}`);
        }
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      fail(statement, "re-export");
    } else if (ts.isExportAssignment(statement)) {
      fail(statement, "default-export");
    }
  }
  return actions;
}

/** `Promise<ActionResult<…>>` with ActionResult from the kernel seam, or `Promise<never>`. */
function isActionReturn(
  type: ts.TypeNode | undefined,
  actionResult: string | undefined,
): boolean {
  if (
    type === undefined ||
    !ts.isTypeReferenceNode(type) ||
    !ts.isIdentifier(type.typeName) ||
    type.typeName.text !== "Promise"
  ) {
    return false;
  }
  const [argument] = type.typeArguments ?? [];
  if (argument === undefined) return false;
  if (argument.kind === ts.SyntaxKind.NeverKeyword) return true;
  return (
    actionResult !== undefined &&
    ts.isTypeReferenceNode(argument) &&
    ts.isIdentifier(argument.typeName) &&
    argument.typeName.text === actionResult
  );
}

function reachesViewer(
  node: ts.Node,
  resolvers: ReadonlySet<string>,
  locals: ReadonlyMap<string, ts.Node>,
  seen: Set<string>,
): boolean {
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const callee = node.expression.text;
    if (resolvers.has(callee)) return true;
    const local = locals.get(callee);
    if (local && !seen.has(callee)) {
      seen.add(callee);
      if (reachesViewer(local, resolvers, locals, seen)) return true;
    }
  }
  return (
    ts.forEachChild(
      node,
      (child) => reachesViewer(child, resolvers, locals, seen) || undefined,
    ) ?? false
  );
}

/** An org or workspace id destructured from, or read off, an action's parameter. */
function parameterTenantReads(sf: ts.SourceFile, action: Action, fail: Fail) {
  const parameters = new Set<string>();
  for (const parameter of action.fn.parameters) {
    if (ts.isIdentifier(parameter.name)) {
      parameters.add(parameter.name.text);
    } else if (ts.isObjectBindingPattern(parameter.name)) {
      for (const element of parameter.name.elements) {
        const key = (element.propertyName ?? element.name).getText(sf);
        if (TENANT_ID.test(key)) fail(element, `tenant-from-input:${key}`);
      }
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      parameters.has(node.expression.text) &&
      TENANT_ID.test(node.name.text)
    ) {
      fail(node, `tenant-from-input:${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  if (action.fn.body) visit(action.fn.body);
}

/** `….get("orgId")` anywhere in the module: a form field named for a tenant id. */
function formTenantReads(sf: ts.SourceFile, fail: Fail) {
  const visit = (node: ts.Node): void => {
    const [field] = ts.isCallExpression(node) ? node.arguments : [];
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "get" &&
      field !== undefined &&
      ts.isStringLiteralLike(field) &&
      TENANT_ID.test(field.text)
    ) {
      fail(node, `tenant-from-input:${field.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

function actionViolations(source: SourceText): string[] {
  const sf = parse(source);
  if (directiveOf(sf) !== "use server") return [];
  const violations: string[] = [];
  const fail: Fail = (node, what) => {
    violations.push(
      `${RULE} ${source.file}:${String(lineOf(sf, node))} ${what}`,
    );
  };
  const resolvers = new Set(
    [...importsFrom(sf, "@/server/viewer")]
      .filter(([imported]) => VIEWER_RESOLVERS.has(imported))
      .map(([, local]) => local),
  );
  const actionResult = importsFrom(sf, "@/server/kernel").get("ActionResult");
  const locals = localFunctions(sf);
  for (const action of actionsOf(sf, fail)) {
    if (!isActionReturn(action.fn.type, actionResult)) {
      fail(action.at, `return-type:${action.name}`);
    }
    if (
      action.fn.body === undefined ||
      !reachesViewer(action.fn.body, resolvers, locals, new Set())
    ) {
      fail(action.at, `no-viewer:${action.name}`);
    }
    parameterTenantReads(sf, action, fail);
  }
  formTenantReads(sf, fail);
  return violations;
}

const probe = (name: string): string[] =>
  actionViolations(readSource(`${PROBES}/${name}`));

describe("server actions", () => {
  it(
    'every "use server" module under src/ keeps the action contract',
    () => {
      const modules = productionFiles()
        .map(readSource)
        .filter((source) => directiveOf(scan(source)) === "use server");
      expect(modules.length).toBeGreaterThan(0);
      expect(modules.flatMap(actionViolations)).toEqual([]);
    },
    WHOLE_TREE_TIMEOUT_MS,
  );

  it("ActionResult and never returns, a viewer reached through a helper and a slug from the form pass", () => {
    expect(probe("ok.ts")).toEqual([]);
  });

  it('a "use server" export returning a bare Promise<void> fails', () => {
    expect(probe("bare-promise.ts")).toEqual([
      `${RULE} ${PROBES}/bare-promise.ts:4 return-type:touch`,
    ]);
  });

  it("an action that never requires a viewer fails", () => {
    expect(probe("no-viewer.ts")).toEqual([
      `${RULE} ${PROBES}/no-viewer.ts:4 no-viewer:ping`,
    ]);
  });

  it("an action reading its org from a form field fails", () => {
    expect(probe("form-org.ts")).toEqual([
      `${RULE} ${PROBES}/form-org.ts:9 tenant-from-input:orgId`,
    ]);
  });

  it("an action reading a workspace id off its input, or destructuring an org id, fails", () => {
    expect(probe("input-workspace.ts")).toEqual([
      `${RULE} ${PROBES}/input-workspace.ts:9 tenant-from-input:workspaceId`,
    ]);
    expect(probe("destructured-org.ts")).toEqual([
      `${RULE} ${PROBES}/destructured-org.ts:6 tenant-from-input:orgId`,
    ]);
  });

  it("exports that are not actions fail", () => {
    expect(probe("other-exports.ts")).toEqual([
      `${RULE} ${PROBES}/other-exports.ts:4 not-an-action:LIMIT`,
      `${RULE} ${PROBES}/other-exports.ts:5 re-export`,
    ]);
  });

  it("selects by the directive: the same code without it is not an action module", () => {
    expect(probe("no-directive.ts")).toEqual([]);
  });

  it("exempts no pre-auth action, not even in the auth lane (#4042)", () => {
    const { text } = readSource(`${PROBES}/pre-auth.ts`);
    for (const file of [
      "src/features/auth/actions.ts",
      "src/features/billing/actions.ts",
    ]) {
      expect(actionViolations({ file, text })).toEqual([
        `${RULE} ${file}:3 return-type:requestPasswordReset`,
        `${RULE} ${file}:3 no-viewer:requestPasswordReset`,
      ]);
    }
  });
});
