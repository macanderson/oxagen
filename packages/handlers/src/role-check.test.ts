// role-check.test.ts — INV-29 (apps/app/ARCHITECTURE.md §3.2, §4): a contract
// with a role restriction is enforced by its handler, because the kernel's
// IAM check allows every capability for a non-enterprise organization.
//
// The arrays below name the contracts whose handlers carry the gate. For each
// one the test finds the module the handler loads from — `register.ts` for
// packages/handlers, the `LOADERS` map in `index.ts` for packages/agent —
// parses that module with the TypeScript compiler API and asserts the
// exported handler contains a call expression to a role gate: in its
// initializer, in the same-file factory its initializer calls, or in its body
// when it is a function declaration. A role gate is `assertOrgRole`, or
// `assertConsequenceRole` (`@oxagen/iam/mandate-role`), which asks for the org
// roles a workspace names for a consequence and calls `assertOrgRole` with the
// resolved user itself (rule two scans that call), or `assertContractRole`
// (`./lib/capability-role-guard`), which asks for the roles the contract's
// `defaultRoles` grants the same way. Every entry must also be a
// registered contract, so a renamed capability fails here rather than silently
// dropping out of the gate. The arrays grow with each lane that adds a
// role-checked handler.
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
  "purchase_credits",
  "register_agent",
  "rotate_agent_credential",
  "suspend_agent",
  "retire_agent",
  "commit_agent_definition",
  "propose_agent",
  "propose_skill",
  "grant_mandate",
  "request_mandate",
  "revoke_mandate",
  "update_mandate_limits",
  "publish_tool_declaration",
  "list_approval_rules",
  "set_approval_rules",
  "delete_approval_rule",
  "set_approval_rule_enabled",
  "get_auto_eligibility",
  "update_workspace_settings",
  "set_spend_budget",
  "set_price_entry",
  "remove_price_entry",
  // Reads of the same commercial detail set/remove already gate (#3271
  // residue): the contract's Owner/Admin/Billing/Member roles were decorative
  // on a non-enterprise organization until the handler asserted them too.
  "list_price_entries",
  "list_unpriced_models",
  "append_record",
  "propose_record",
  "dismiss_proposal",
  "open_context_pr",
  "query_audit_log",
  "export_audit_events",
  "list_skills",
  "get_run_proof",
  "set_disclosure_grain",
  // The six the Tools page invokes (#3143). Each already asserted its own
  // role; none was named here, so the assertion was unpinned and a handler
  // that dropped it would have passed the whole gate. The page's own tests
  // could not have caught that: they prove the buttons match what the
  // contracts declare, which is a claim about the surface, not about whether
  // the server enforces it. That distinction is the point of INV-29, and for
  // these six it mattered more than usual — `import_tools` is one of the few
  // capabilities whose gate admits somebody the org-role check alone would
  // refuse, so its assertion is the only thing that decides the case.
  "import_tools",
  "set_tool_classification",
  "set_kill_switch",
  "list_tool_versions",
  "list_credential_grants",
  "list_kill_switches",
  // The organisation's model-vendor key (ADR-053 §2). All four shipped with
  // no role check, relying on `defaultRoles`, which the non-enterprise IAM
  // fast path never reads — so any member could set the key, and with an
  // `openai_compatible` endpoint route the org's assistant traffic to a
  // server they control.
  "get_model_credential",
  "set_model_credential",
  "delete_model_credential",
  "verify_model_credential",
  // Cost-center chargeback (ADR-142). The list's editors and the readers of
  // the organization-wide statement are Owner, Admin and Billing.
  // `list_cost_centers` admits every Member, so it carries no gate.
  "create_cost_center",
  "delete_cost_center",
  "set_cost_center",
  "export_cost_center_statement",
  // A verdict on an assistant reply (#4169) takes ask_assistant's roles, and
  // ask_assistant asserts them in its turn, so this handler asserts them too.
  "record_reply_feedback",
  // Thirty agent-surface contracts that granted only narrow roles while their
  // handlers checked none (#4194). A workspace Member could reach each one
  // over the API, over MCP, and through stella's search_tools and
  // load_tools. Each now calls assertContractRole with its own contract.
  "bind_agent_environment",
  "unbind_agent_environment",
  "create_environment",
  "update_environment",
  "delete_environment",
  "set_default_environment",
  "unset_secret_value",
  "install_plugin",
  "install_plugins_bulk",
  "uninstall_plugin",
  "set_plugin_enabled",
  "add_plugin_registry",
  "remove_plugin_registry",
  "set_auth_alerts",
  "get_auth_alerts",
  "update_org_settings",
  "update_prompt_settings",
  "update_budget_policy",
  "update_model_settings",
  "update_memory_policy",
  "set_connection_mappings",
  "suggest_connection_mappings",
  "reauth_plugin_credential",
  "get_usage_breakdown",
  "get_evidence_retention",
  "list_iam_roles",
  "get_capability_registry",
  "list_capability_registry",
  "browse_plugin_catalog",
  "get_catalog_plugin",
] as const;

const AGENT_ROLE_CHECKED_CONTRACTS = [
  "resolve_approval",
  "assign_agent_role",
  "revoke_agent_role",
  // A rule-authoring turn (ADR-186) takes ask_assistant's roles, and asserts
  // them before it asks for the turn.
  "author_graph_rule",
] as const;

const SRC = join(__dirname);
const PACKAGES = join(SRC, "..", "..");
const AGENT_HANDLERS = join(PACKAGES, "agent", "src", "handlers");

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

/** The `./module` packages/agent's `LOADERS` entry for a capability imports. */
function agentHandlerModule(
  indexSource: ts.SourceFile,
  capability: string,
): string {
  let module: string | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      node.name.text === capability
    ) {
      module = /import\("(\.\/[^"]+)"\)/.exec(
        node.initializer.getText(indexSource),
      )?.[1];
    }
    ts.forEachChild(node, visit);
  };
  visit(indexSource);
  if (!module) {
    throw new Error(
      `packages/agent LOADERS binds no handler for ${capability}`,
    );
  }
  return module;
}

const isExported = (node: ts.Node): boolean =>
  ts.canHaveModifiers(node) &&
  (ts.getModifiers(node) ?? []).some(
    (m) => m.kind === ts.SyntaxKind.ExportKeyword,
  );

/**
 * The module's one exported `*Handler` — the fallback `resolveHandler` in
 * packages/agent/src/handlers/index.ts resolves a snake_case capability by.
 */
function soleHandlerExport(source: ts.SourceFile): string {
  const names: string[] = [];
  for (const statement of source.statements) {
    if (!isExported(statement)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text);
      }
    }
  }
  const handlers = names.filter((n) => n.endsWith("Handler"));
  if (handlers.length !== 1) {
    throw new Error(
      `${source.fileName} exports ${handlers.length} *Handler names`,
    );
  }
  return handlers[0]!;
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

/**
 * The calls that gate a handler on an org role. `assertContractRole`
 * (`./lib/capability-role-guard`) calls `assertOrgRole` with the resolved
 * user and the contract's own roles, and rule two scans that call.
 */
const ROLE_GATES = [
  "assertOrgRole",
  "assertConsequenceRole",
  "assertContractRole",
] as const;

/**
 * Whether the exported handler contains a call to a role gate: in its
 * initializer (`export const h = async (…) => …`), in the body of the
 * same-file factory its initializer calls (`export const h = createH(deps)`),
 * or in its body when it is a function declaration.
 */
function handlerCallsRoleGate(
  source: ts.SourceFile,
  exportName: string,
): boolean {
  let calls = false;
  const scan = (node: ts.Node) => {
    if (ROLE_GATES.some((gate) => isCallTo(node, gate))) calls = true;
    ts.forEachChild(node, scan);
  };
  const functionNamed = (name: string) =>
    source.statements.find(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && s.name?.text === name,
    );
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === exportName
    ) {
      scan(statement);
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(decl.name) ||
        decl.name.text !== exportName ||
        !decl.initializer
      )
        continue;
      scan(decl.initializer);
      if (
        ts.isCallExpression(decl.initializer) &&
        ts.isIdentifier(decl.initializer.expression)
      ) {
        const factory = functionNamed(decl.initializer.expression.text);
        if (factory) scan(factory);
      }
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

  it("the scan sees assertContractRole as a gate", () => {
    const source = parseSource(
      "probe.ts",
      `export const handler = async (_input, ctx) => {
         await assertContractRole(contract, ctx);
       };`,
    );
    expect(handlerCallsRoleGate(source, "handler")).toBe(true);
  });
});

describe("INV-29: role-restricted packages/agent contracts are gated in their handler", () => {
  const index = parse(join(AGENT_HANDLERS, "index.ts"));
  const handlerSource = (name: string) =>
    parse(join(AGENT_HANDLERS, `${agentHandlerModule(index, name)}.ts`));

  it.each(AGENT_ROLE_CHECKED_CONTRACTS)(
    "%s is a registered contract",
    (name) => {
      expect(getCapability(name)?.name).toBe(name);
    },
  );

  it.each(AGENT_ROLE_CHECKED_CONTRACTS)(
    "%s's handler body calls assertOrgRole",
    (name) => {
      const source = handlerSource(name);
      expect(handlerCallsRoleGate(source, soleHandlerExport(source))).toBe(
        true,
      );
    },
  );

  it("the scan itself sees no gate in an agent handler that has none", () => {
    const source = handlerSource("list_agent_roles");
    expect(handlerCallsRoleGate(source, soleHandlerExport(source))).toBe(false);
  });
});

describe("INV-29: every role gate acts as the resolved user", () => {
  const callers = gateCallers();

  it("finds the gates in packages/handlers and packages/agent", () => {
    const names = callers.map((f) => relative(PACKAGES, f));
    expect(names).toEqual(
      expect.arrayContaining([
        "agent/src/handlers/agent.approval.resolve.ts",
        "agent/src/handlers/agent.role.assign.ts",
        "agent/src/handlers/agent.role.revoke.ts",
        "handlers/src/billing.credits.purchase.ts",
        "handlers/src/billing.gau_bucket.purchase.ts",
        "handlers/src/billing.invoice.list.ts",
        "handlers/src/context.pr.open.ts",
        "handlers/src/context.records.append.ts",
        "handlers/src/tacho.command.dispatch.ts",
        "handlers/src/audit.events.export.ts",
        "handlers/src/audit.log.query.ts",
        "handlers/src/workspace.archive.ts",
        "handlers/src/lib/capability-role-guard.ts",
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

    /** The factory shape the steering handlers use. */
    const factoryProbe = (body: string) =>
      gatesWithoutActingUser(
        parseSource(
          "probe.ts",
          `export function createHandler(deps) {\n  return async (_input, ctx) => {\n${body}\n  };\n}\nexport const handler = createHandler({});`,
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

    it("passes a factory's handler that resolves the user and passes it", () => {
      expect(
        factoryProbe(
          `const actingUserId = await resolveActingUserId(ctx);
           await assertOrgRole({ ...ctx, userId: actingUserId }, { org: ["Owner"] });`,
        ),
      ).toEqual([]);
    });

    it("fails a gate passed ctx itself", () => {
      expect(
        probe(`await assertOrgRole(ctx, { org: ["Owner"] });`),
      ).toHaveLength(1);
    });

    it("fails a factory's handler that passes ctx inside a signed-in check", () => {
      expect(
        factoryProbe(
          `if (ctx.userId) {
             await assertOrgRole(ctx, { org: ["Owner"], workspace: ["Member"] });
           }`,
        ),
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

  describe("the handler-body scan", () => {
    it("follows an exported handler into the same-file factory it calls", () => {
      const source = parseSource(
        "probe.ts",
        `export function createHandler(deps) {\n  return async (_input, ctx) => {\n    await assertOrgRole({ ...ctx, userId: null }, { org: ["Owner"] });\n  };\n}\nexport const handler = createHandler({});`,
      );
      expect(handlerCallsRoleGate(source, "handler")).toBe(true);
    });

    it("reads an exported function declaration's body", () => {
      const source = parseSource(
        "probe.ts",
        `export async function probeHandler(_input, ctx) {\n  await assertOrgRole({ ...ctx, userId: null }, { org: ["Owner"] });\n}`,
      );
      expect(handlerCallsRoleGate(source, "probeHandler")).toBe(true);
      expect(soleHandlerExport(source)).toBe("probeHandler");
    });
  });
});
