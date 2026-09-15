// role-check.test.ts — INV-29 (apps/app/ARCHITECTURE.md §3.2, §4): a contract
// with a role restriction is enforced by its handler, because the kernel's
// IAM check allows every capability for a non-enterprise organization.
//
// The array below names the contracts whose handlers carry the gate. For each
// one the test reads `register.ts` for the module the handler loads from,
// parses that module with the TypeScript compiler API and asserts the
// exported handler's body contains a call expression to a role gate:
// `assertOrgRole`, or `assertConsequenceRole` (`@oxagen/iam/mandate-role`),
// which asks for the org roles a workspace names for a consequence and calls
// `assertOrgRole` with the resolved user itself (rule two scans that call).
// Every entry must also be a registered contract, so a renamed capability
// fails here rather than silently dropping out of the gate. The array grows
// with each lane that adds a role-checked handler.
//
// The second rule covers every `assertOrgRole` call under packages/*/src: an
// API key acts as its creator, bounded by the creator's current org role
// (ARCHITECTURE.md §9, 2026-09-15). The call's first argument is an object
// literal whose `userId` is the result of `resolveActingUserId` — inline, or a
// const the same function declared from it. A gate passed `ctx` itself reads
// `ctx.userId`, which is null on every API-key call, and fails here.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
  "grant_mandate",
  "request_mandate",
  "revoke_mandate",
  "update_mandate_limits",
  "publish_tool_declaration",
  "update_workspace_settings",
] as const;

const SRC = join(__dirname);
const PACKAGES = join(SRC, "..", "..");

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

function parseSource(file: string, text: string): ts.SourceFile {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
}

function parse(file: string): ts.SourceFile {
  return parseSource(file, readFileSync(file, "utf8"));
}

const isCallTo = (node: ts.Node, name: string): node is ts.CallExpression =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  node.expression.text === name;

/** The calls that gate a handler on an org role. */
const ROLE_GATES = ["assertOrgRole", "assertConsequenceRole"] as const;

/** Whether the exported handler's initializer contains a call to a role gate. */
function handlerCallsRoleGate(
  source: ts.SourceFile,
  exportName: string,
): boolean {
  let calls = false;
  const scan = (node: ts.Node) => {
    if (ROLE_GATES.some((gate) => isCallTo(node, gate))) calls = true;
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

/** `resolveActingUserId(...)` or `await resolveActingUserId(...)`. */
function isResolvedActingUser(expr: ts.Expression): boolean {
  const inner = ts.isAwaitExpression(expr) ? expr.expression : expr;
  return isCallTo(inner, "resolveActingUserId");
}

/** Whether `fn` declares `name` as a variable initialised from `resolveActingUserId`. */
function declaresActingUser(fn: ts.Node, name: string): boolean {
  let declared = false;
  const scan = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer &&
      isResolvedActingUser(node.initializer)
    )
      declared = true;
    ts.forEachChild(node, scan);
  };
  scan(fn);
  return declared;
}

/**
 * Every `assertOrgRole` call in `source` whose first argument does not carry
 * the acting user, as `line:column` locations. An empty list is a pass.
 */
function gatesWithoutActingUser(source: ts.SourceFile): string[] {
  const failures: string[] = [];
  const visit = (node: ts.Node) => {
    if (isCallTo(node, "assertOrgRole")) {
      let fn: ts.Node | undefined = node.parent;
      while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
      const arg = node.arguments[0];
      const userId =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find(
              (p) =>
                p.name !== undefined &&
                ts.isIdentifier(p.name) &&
                p.name.text === "userId",
            )
          : undefined;
      const ok =
        fn !== undefined &&
        userId !== undefined &&
        ((ts.isPropertyAssignment(userId) &&
          (isResolvedActingUser(userId.initializer) ||
            (ts.isIdentifier(userId.initializer) &&
              declaresActingUser(fn, userId.initializer.text)))) ||
          (ts.isShorthandPropertyAssignment(userId) &&
            declaresActingUser(fn, "userId")));
      if (!ok) {
        const { line, character } = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        failures.push(`${line + 1}:${character + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return failures;
}

/** Non-test TypeScript under every `packages/<name>/src` that calls `assertOrgRole`. */
function gateCallers(): string[] {
  const files: string[] = [];
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(PACKAGES, pkg.name, "src");
    let entries: string[];
    try {
      entries = readdirSync(src, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (
        !entry.endsWith(".ts") ||
        entry.endsWith(".d.ts") ||
        /\.test(-support)?\.ts$/.test(entry) ||
        entry.includes("node_modules")
      )
        continue;
      const file = join(src, entry);
      if (readFileSync(file, "utf8").includes("assertOrgRole(")) {
        files.push(file);
      }
    }
  }
  return files;
}

describe("INV-29: role-restricted contracts are gated in their handler", () => {
  const register = parse(join(SRC, "register.ts"));

  it.each(ROLE_CHECKED_CONTRACTS)("%s is a registered contract", (name) => {
    expect(getCapability(name)?.name).toBe(name);
  });

  it.each(ROLE_CHECKED_CONTRACTS)(
    "%s's handler body calls a role gate",
    (name) => {
      const { module, exportName } = handlerBinding(register, name);
      const source = parse(join(SRC, `${module}.ts`));
      expect(handlerCallsRoleGate(source, exportName)).toBe(true);
    },
  );

  it("the scan itself sees no gate in a handler that has none", () => {
    const { module, exportName } = handlerBinding(register, "list_incidents");
    const source = parse(join(SRC, `${module}.ts`));
    expect(handlerCallsRoleGate(source, exportName)).toBe(false);
  });

  it("the scan sees assertConsequenceRole as a gate", () => {
    const source = parseSource(
      "probe.ts",
      `export const handler = async (_input, ctx) => {
         await assertConsequenceRole(ctx, ["moves_money"], {});
       };`,
    );
    expect(handlerCallsRoleGate(source, "handler")).toBe(true);
  });
});

describe("INV-29: every role gate acts as the resolved user", () => {
  const callers = gateCallers();

  it("finds the gates in packages/handlers and packages/agent", () => {
    const names = callers.map((f) => relative(PACKAGES, f));
    expect(names).toEqual(
      expect.arrayContaining([
        "agent/src/handlers/agent.approval.resolve.ts",
        "handlers/src/billing.gau_bucket.purchase.ts",
        "handlers/src/billing.invoice.list.ts",
        "handlers/src/tacho.command.dispatch.ts",
        "handlers/src/workspace.archive.ts",
        "iam/src/mandate-role.ts",
      ]),
    );
  });

  it("every assertOrgRole call passes the user resolveActingUserId returned", () => {
    const failures = callers.flatMap((file) =>
      gatesWithoutActingUser(parse(file)).map(
        (at) => `${relative(PACKAGES, file)}:${at}`,
      ),
    );
    expect(failures).toEqual([]);
  });

  describe("probes", () => {
    const probe = (body: string) =>
      gatesWithoutActingUser(
        parseSource(
          "probe.ts",
          `export const handler = async (_input, ctx) => {\n${body}\n};`,
        ),
      );

    it("passes a const resolved in the same function", () => {
      expect(
        probe(
          `const actingUserId = await resolveActingUserId(ctx);
           await assertOrgRole({ ...ctx, userId: actingUserId }, { org: ["Owner"] });`,
        ),
      ).toEqual([]);
    });

    it("passes an inline resolve", () => {
      expect(
        probe(
          `await assertOrgRole({ ...ctx, userId: await resolveActingUserId(ctx) }, { org: ["Owner"] });`,
        ),
      ).toEqual([]);
    });

    it("passes a shorthand userId resolved in the same function", () => {
      expect(
        probe(
          `const userId = await resolveActingUserId(ctx);
           await assertOrgRole({ ...ctx, userId }, { org: ["Owner"] });`,
        ),
      ).toEqual([]);
    });

    it("fails a gate passed ctx itself", () => {
      expect(
        probe(`await assertOrgRole(ctx, { org: ["Owner"] });`),
      ).toHaveLength(1);
    });

    it("fails a gate that resolves the user and then passes ctx", () => {
      expect(
        probe(
          `const actingUserId = await resolveActingUserId(ctx);
           await assertOrgRole(ctx, { org: ["Owner"] });`,
        ),
      ).toHaveLength(1);
    });

    it("fails a gate passed ctx.userId", () => {
      expect(
        probe(
          `await assertOrgRole({ ...ctx, userId: ctx.userId }, { org: ["Owner"] });`,
        ),
      ).toHaveLength(1);
    });

    it("fails a const that did not come from resolveActingUserId", () => {
      expect(
        probe(
          `const actingUserId = ctx.userId;
           await assertOrgRole({ ...ctx, userId: actingUserId }, { org: ["Owner"] });`,
        ),
      ).toHaveLength(1);
    });
  });
});
