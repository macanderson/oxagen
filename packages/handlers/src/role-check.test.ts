// role-check.test.ts — INV-29 (apps/app/ARCHITECTURE.md §3.2, §4): a contract
// with a role restriction is enforced by its handler, because the kernel's
// IAM check allows every capability for a non-enterprise organization.
//
// The array below names the contracts whose handlers carry the gate. For each
// one the test reads `register.ts` for the module the handler loads from,
// parses that module with the TypeScript compiler API and asserts the
// exported handler's body contains a call expression to `assertOrgRole`.
// Every entry must also be a registered contract, so a renamed capability
// fails here rather than silently dropping out of the gate. The array grows
// with each lane that adds a role-checked handler.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { getCapability } from "@oxagen/oxagen";

const ROLE_CHECKED_CONTRACTS = [
  "authorize_cli",
  "register_agent",
  "rotate_agent_credential",
  "suspend_agent",
  "retire_agent",
  "commit_agent_definition",
] as const;

const SRC = join(__dirname);

/** The `./module` and export name `register.ts` binds a capability to. */
function handlerBinding(
  registerSource: ts.SourceFile,
  capability: string,
): { module: string; exportName: string } {
  let found: { module: string; exportName: string } | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "registerHandler" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === capability
    ) {
      const text = node.arguments[1]?.getText(registerSource) ?? "";
      const module = /import\("(\.\/[^"]+)"\)/.exec(text)?.[1];
      const exportName = /\)\)\s*\.(\w+)/.exec(text)?.[1];
      if (module && exportName) found = { module, exportName };
    }
    ts.forEachChild(node, visit);
  };
  visit(registerSource);
  if (!found) throw new Error(`register.ts binds no handler for ${capability}`);
  return found;
}

function parse(file: string): ts.SourceFile {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}

/** Whether the exported handler's initializer contains a call to `assertOrgRole`. */
function handlerCallsAssertOrgRole(
  source: ts.SourceFile,
  exportName: string,
): boolean {
  let calls = false;
  const scan = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "assertOrgRole"
    )
      calls = true;
    ts.forEachChild(node, scan);
  };
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(decl.name) &&
        decl.name.text === exportName &&
        decl.initializer
      )
        scan(decl.initializer);
    }
  }
  return calls;
}

describe("INV-29: role-restricted contracts are gated in their handler", () => {
  const register = parse(join(SRC, "register.ts"));

  it.each(ROLE_CHECKED_CONTRACTS)("%s is a registered contract", (name) => {
    expect(getCapability(name)?.name).toBe(name);
  });

  it.each(ROLE_CHECKED_CONTRACTS)(
    "%s's handler body calls assertOrgRole",
    (name) => {
      const { module, exportName } = handlerBinding(register, name);
      const source = parse(join(SRC, `${module}.ts`));
      expect(handlerCallsAssertOrgRole(source, exportName)).toBe(true);
    },
  );

  it("the scan itself sees no gate in a handler that has none", () => {
    const { module, exportName } = handlerBinding(register, "list_incidents");
    const source = parse(join(SRC, `${module}.ts`));
    expect(handlerCallsAssertOrgRole(source, exportName)).toBe(false);
  });
});
