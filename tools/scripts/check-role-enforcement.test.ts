import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSource, withoutComments } from "./lib/role-gate-ast.mjs";
import {
  declaredCapabilityName,
  declaresAgentRoleRestriction,
  declaresRoleRestriction,
  findGaps,
  parseDefaultRoles,
  parseSurfaces,
  resolveHandler,
  ROLE_ENFORCEMENT_BASELINE,
  ROLE_ENFORCEMENT_EXEMPT,
} from "./check-role-enforcement.mjs";

describe("declaresRoleRestriction", () => {
  it("is true for sensitivity: high with a defaultRoles block", () => {
    expect(
      declaresRoleRestriction(
        'sensitivity: "high",\ndefaultRoles: {\n  org: { Owner: "allow" },\n},',
      ),
    ).toBe(true);
  });

  it("is false without sensitivity: high", () => {
    expect(
      declaresRoleRestriction(
        'sensitivity: "low",\ndefaultRoles: {\n  org: { Owner: "allow" },\n},',
      ),
    ).toBe(false);
  });

  it("is false without a defaultRoles block", () => {
    expect(declaresRoleRestriction('sensitivity: "high",')).toBe(false);
  });
});

describe("declaredCapabilityName", () => {
  it("reads the registered name", () => {
    expect(declaredCapabilityName('name: "create_connection",')).toBe(
      "create_connection",
    );
  });

  it("is null when no name field is present", () => {
    expect(declaredCapabilityName("domain: 'connection',")).toBeNull();
  });
});

describe("against the real tree", () => {
  it("connection.create is no longer in the baseline — it is enforced now", () => {
    expect(ROLE_ENFORCEMENT_BASELINE.has("connection.create")).toBe(false);
  });
});

// #4194: the scan covers every agent-surface contract, finds handlers by
// registered name, parses a one-line defaultRoles, and follows a helper.
describe("parseDefaultRoles", () => {
  it("parses a block that spans lines", () => {
    expect(
      parseDefaultRoles(
        'defaultRoles: {\n  org: {\n    Owner: "allow",\n    Admin: "deny",\n  },\n  workspace: { Member: "allow" },\n},',
      ),
    ).toEqual({
      org: { Owner: "allow", Admin: "deny" },
      workspace: { Member: "allow" },
    });
  });

  it("parses a block on one line", () => {
    expect(
      parseDefaultRoles(
        'defaultRoles: { org: { Owner: "allow" }, workspace: {} },',
      ),
    ).toEqual({ org: { Owner: "allow" }, workspace: {} });
  });

  it("is null without a defaultRoles block", () => {
    expect(parseDefaultRoles('sensitivity: "low",')).toBeNull();
  });

  it("makes a one-line block count for the high-sensitivity rule", () => {
    expect(
      declaresRoleRestriction(
        'sensitivity: "high", defaultRoles: { org: { Owner: "allow" }, workspace: {} },',
      ),
    ).toBe(true);
  });
});

// #4664 item 7: the contract readers took the first match in the raw file.
// billing.contract_terms.set.ts, billing.org_terms.set.ts and
// billing.prepaid_invoice.create.ts each quote `surfaces: []` in a doc comment
// above the real array, so a comment could decide what the check read.
describe("contract readers ignore comments", () => {
  const withHeader = (header: string, body: string) =>
    `/**\n * ${header}\n */\nexport const x = registerCapability({\n${body}\n});\n`;

  it("reads the declared surfaces, not ones a header comment quotes", () => {
    const src = withHeader(
      "Was `surfaces: []` before the agent surface was added.",
      '  surfaces: ["api", "mcp", "agent"],',
    );
    expect(parseSurfaces(src)).toEqual(["api", "mcp", "agent"]);
  });

  it("keeps the agent rule on a contract whose comment quotes other surfaces", () => {
    const src = withHeader(
      'Formerly `surfaces: ["api"]`.',
      '  surfaces: ["agent"],\n  sensitivity: "low",\n  defaultRoles: { org: { Owner: "allow" }, workspace: { Owner: "allow" } },',
    );
    expect(declaresAgentRoleRestriction(src)).toBe(true);
  });

  it("reads the declared roles, not a grant a comment quotes", () => {
    const src = withHeader(
      'Once `defaultRoles: { workspace: { Member: "allow" } }`.',
      '  surfaces: ["agent"],\n  // defaultRoles: { workspace: { Member: "allow" } },\n  defaultRoles: { org: { Owner: "allow" }, workspace: { Owner: "allow" } },',
    );
    expect(parseDefaultRoles(src)).toEqual({
      org: { Owner: "allow" },
      workspace: { Owner: "allow" },
    });
    expect(declaresAgentRoleRestriction(src)).toBe(true);
  });

  it("reads sensitivity and name from code only", () => {
    const src = withHeader(
      'Was `name: "old_name"` with `sensitivity: "high"`.',
      '  name: "new_name",\n  sensitivity: "low",\n  defaultRoles: { org: { Owner: "allow" } },',
    );
    expect(declaredCapabilityName(src)).toBe("new_name");
    expect(declaresRoleRestriction(src)).toBe(false);
  });

  it("blanks comments and leaves strings, templates, and regexes alone", () => {
    const src = [
      'const url = "https://example.com/a"; // trailing',
      "const re = /^https?:\\/\\//;",
      "const t = `a // b ${1 /* inner */} c`;",
      "/* block */ const n = 1;",
    ].join("\n");
    const out = withoutComments("probe.ts", src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"https://example.com/a"');
    expect(out).toContain("/^https?:\\/\\//");
    expect(out).toContain("`a // b ${1 ");
    expect(out).not.toMatch(/trailing|inner|block/);
  });
});

describe("declaresAgentRoleRestriction", () => {
  const agentContract = (workspace: string) =>
    `surfaces: ["api", "mcp", "agent"],\nsensitivity: "low",\ndefaultRoles: { org: { Owner: "allow" }, workspace: ${workspace} },`;

  it("is true for an agent-surface contract that withholds workspace Member", () => {
    expect(
      declaresAgentRoleRestriction(agentContract('{ Owner: "allow" }')),
    ).toBe(true);
  });

  it("is false when the contract grants workspace Member", () => {
    expect(
      declaresAgentRoleRestriction(agentContract('{ Member: "allow" }')),
    ).toBe(false);
  });

  it("does not count require_approval as a grant", () => {
    expect(
      declaresAgentRoleRestriction(
        agentContract('{ Member: "require_approval" }'),
      ),
    ).toBe(true);
  });

  it("is false off the agent surface", () => {
    expect(
      declaresAgentRoleRestriction(
        'surfaces: ["api"],\ndefaultRoles: { org: { Owner: "allow" }, workspace: {} },',
      ),
    ).toBe(false);
  });
});

describe("resolveHandler", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("reads register.ts first, then LOADERS, then the stem path", () => {
    dir = mkdtempSync(join(tmpdir(), "role-enforcement-resolve-"));
    const handlersDir = join(dir, "h");
    const agentHandlersDir = join(dir, "a");
    mkdirSync(handlersDir);
    mkdirSync(agentHandlersDir);
    writeFileSync(
      join(handlersDir, "widget.build.ts"),
      "export const x = 1;\n",
    );
    writeFileSync(join(handlersDir, "gizmo.make.ts"), "export const y = 1;\n");
    writeFileSync(
      join(agentHandlersDir, "gadget.list.ts"),
      "export const gadgetListHandler = () => {};\n",
    );
    const registerSource = parseSource(
      "register.ts",
      `registerHandler(
  "make_widget",
  async () =>
    (await import("./widget.build")).widgetBuildHandler as CapabilityHandlerFn,
);
registerHandler("fetch_thing", async () =>
  import("./widget.build").then((m) => m.fetchThingHandler as CapabilityHandlerFn),
);`,
    );
    const agentIndexSource = parseSource(
      "index.ts",
      `const LOADERS = {\n  list_gadgets: () =>\n    import("./gadget.list"),\n};`,
    );
    const args = {
      registerSource,
      agentIndexSource,
      handlersDir,
      agentHandlersDir,
    };
    expect(resolveHandler({ ...args, name: "make_widget", stem: "x" })).toEqual(
      {
        file: join(handlersDir, "widget.build.ts"),
        exportName: "widgetBuildHandler",
      },
    );
    expect(resolveHandler({ ...args, name: "fetch_thing", stem: "x" })).toEqual(
      {
        file: join(handlersDir, "widget.build.ts"),
        exportName: "fetchThingHandler",
      },
    );
    expect(
      resolveHandler({ ...args, name: "list_gadgets", stem: "x" }),
    ).toEqual({
      file: join(agentHandlersDir, "gadget.list.ts"),
      exportName: "gadgetListHandler",
    });
    expect(
      resolveHandler({ ...args, name: "make_gizmo", stem: "gizmo.make" }),
    ).toEqual({ file: join(handlersDir, "gizmo.make.ts"), exportName: null });
    expect(
      resolveHandler({ ...args, name: "none", stem: "missing" }),
    ).toBeNull();
  });
});

describe("findGaps on the agent surface", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "role-enforcement-agent-"));
    const contractsDir = join(dir, "contracts");
    const handlersDir = join(dir, "handlers");
    const agentHandlersDir = join(dir, "agent");
    for (const d of [contractsDir, handlersDir, agentHandlersDir]) {
      mkdirSync(d, { recursive: true });
    }
    return { contractsDir, handlersDir, agentHandlersDir };
  }

  const agentContract = (name: string) =>
    `export const x = registerCapability({\n  name: "${name}",\n  surfaces: ["api", "mcp", "agent"],\n  sensitivity: "medium",\n  defaultRoles: { org: { Owner: "allow", Admin: "allow" }, workspace: {} },\n});\n`;

  it("flags an agent-surface contract of any sensitivity whose handler asserts no role", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      agentContract("make_widget"),
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      "export const h = () => {};\n",
    );
    const { gaps, checked } = findGaps({ ...dirs, baseline: new Set() });
    expect(gaps).toEqual([
      expect.objectContaining({ name: "make_widget", rule: "agent_surface" }),
    ]);
    expect(checked).toBe(1);
  });

  it("reads the handler register.ts binds by name, not the stem", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      agentContract("make_widget"),
    );
    // The stem file asserts; the bound module does not. The bound one counts.
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      "await assertContractRole(c, ctx);\n",
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.build.ts"),
      "export const widgetBuildHandler = () => {};\n",
    );
    writeFileSync(
      join(dirs.handlersDir, "register.ts"),
      `registerHandler("make_widget", async () => (await import("./widget.build")).widgetBuildHandler);\n`,
    );
    const { gaps } = findGaps({ ...dirs, baseline: new Set() });
    expect(gaps).toEqual([
      expect.objectContaining({
        name: "make_widget",
        handlerPath: join(dirs.handlersDir, "widget.build.ts"),
      }),
    ]);
  });

  it("reads a packages/agent handler through LOADERS", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "gadget.list.ts"),
      agentContract("list_gadgets"),
    );
    writeFileSync(
      join(dirs.agentHandlersDir, "index.ts"),
      'const LOADERS = { list_gadgets: () => import("./gadget.list") };\n',
    );
    writeFileSync(
      join(dirs.agentHandlersDir, "gadget.list.ts"),
      "export const gadgetListHandler = () => {};\n",
    );
    const { gaps } = findGaps({ ...dirs, baseline: new Set() });
    expect(gaps).toEqual([
      expect.objectContaining({
        name: "list_gadgets",
        handlerPath: join(dirs.agentHandlersDir, "gadget.list.ts"),
      }),
    ]);
  });

  it("follows a local helper import one hop", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      agentContract("make_widget"),
    );
    mkdirSync(join(dirs.handlersDir, "lib"));
    writeFileSync(
      join(dirs.handlersDir, "lib", "gate.ts"),
      'import { assertOrgRole } from "@oxagen/iam/org-role";\nexport const gate = assertOrgRole;\n',
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      'import { gate } from "./lib/gate";\nexport const h = (ctx) => gate(ctx);\n',
    );
    expect(findGaps({ ...dirs, baseline: new Set() }).gaps).toEqual([]);
  });

  it("does not follow a second hop", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      agentContract("make_widget"),
    );
    writeFileSync(
      join(dirs.handlersDir, "deep.ts"),
      "export const deep = assertOrgRole;\n",
    );
    writeFileSync(
      join(dirs.handlersDir, "middle.ts"),
      'export { deep as middle } from "./deep";\n',
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      'import { middle } from "./middle";\nexport const h = middle;\n',
    );
    expect(findGaps({ ...dirs, baseline: new Set() }).gaps).toHaveLength(1);
  });

  it("skips an exempt stem", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      agentContract("make_widget"),
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      "export const h = () => {};\n",
    );
    const { gaps, checked } = findGaps({
      ...dirs,
      baseline: new Set(),
      exempt: new Map([["widget.make", "by design"]]),
    });
    expect(gaps).toEqual([]);
    expect(checked).toBe(0);
  });
});

describe("the #4194 baseline and coverage", () => {
  it("no longer lists the seven stems whose handlers enforce", () => {
    for (const stem of [
      "api.key.list",
      "api.key.rotate",
      "context.pr.merge",
      "org.member.add",
      "org.member.remove",
      "org.member_role.change",
      "privacy.data.export",
    ]) {
      expect(ROLE_ENFORCEMENT_BASELINE.has(stem)).toBe(false);
    }
  });

  it("holds at most the thirteen stems it holds today; nothing may enter", () => {
    expect(ROLE_ENFORCEMENT_BASELINE.size).toBeLessThanOrEqual(13);
  });

  it("gives every exemption a reason", () => {
    for (const reason of ROLE_ENFORCEMENT_EXEMPT.values()) {
      expect(reason.length).toBeGreaterThan(20);
    }
  });
});

// #3490: the check reads the handler's code with the TypeScript compiler API,
// resolves a high-sensitivity contract's handler through both registries, and
// checks every baseline stem against its current contract.
describe("findGaps reads code, not text (#3490)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "role-enforcement-ast-"));
    const contractsDir = join(dir, "contracts");
    const handlersDir = join(dir, "handlers");
    const agentHandlersDir = join(dir, "agent");
    for (const d of [contractsDir, handlersDir, agentHandlersDir]) {
      mkdirSync(d, { recursive: true });
    }
    return { contractsDir, handlersDir, agentHandlersDir };
  }

  const highContract = (name: string) =>
    `export const x = registerCapability({\n  name: "${name}",\n  surfaces: ["api"],\n  sensitivity: "high",\n  defaultRoles: { org: { Owner: "allow" }, workspace: {} },\n});\n`;

  /** One restricted contract and its stem-path handler; returns the gaps. */
  function scan(handler: string, extra: Record<string, string> = {}) {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      highContract("make_widget"),
    );
    writeFileSync(join(dirs.handlersDir, "widget.make.ts"), handler);
    for (const [file, text] of Object.entries(extra)) {
      writeFileSync(join(dirs.handlersDir, file), text);
    }
    return findGaps({ ...dirs, baseline: new Set() }).gaps;
  }

  it("flags a handler that names the gate only in a comment", () => {
    expect(
      scan(
        "// Role gate: assertOrgRole(ctx, { org: ['Owner'] }) runs first.\n" +
          "export const widgetMakeHandler = async () => ({ ok: true });\n",
      ),
    ).toEqual([expect.objectContaining({ name: "make_widget" })]);
  });

  it("flags a handler that imports the gate and never uses it", () => {
    expect(
      scan(
        'import { assertOrgRole } from "@oxagen/iam/org-role";\n' +
          "export const widgetMakeHandler = async () => ({ ok: true });\n",
      ),
    ).toHaveLength(1);
  });

  it("flags a gate in a string or in a same-file function the handler never calls", () => {
    expect(
      scan(
        'import { assertOrgRole } from "@oxagen/iam/org-role";\n' +
          "async function unused(ctx) { await assertOrgRole(ctx, {}); }\n" +
          'export const widgetMakeHandler = async () => "assertOrgRole";\n',
      ),
    ).toHaveLength(1);
  });

  it("passes a gate called through a same-file factory", () => {
    expect(
      scan(
        'import { assertOrgRole } from "@oxagen/iam/org-role";\n' +
          "function createHandler(deps) {\n" +
          "  return async (_i, ctx) => { await assertOrgRole(ctx, {}); };\n" +
          "}\n" +
          "export const widgetMakeHandler = createHandler({});\n",
      ),
    ).toEqual([]);
  });

  it("passes a gate imported under another name", () => {
    expect(
      scan(
        'import { resolveActorOrgRole as resolveActorRole } from "@oxagen/iam/org-role";\n' +
          "export const widgetMakeHandler = async (_i, ctx) => {\n" +
          "  if (!(await resolveActorRole(ctx.orgId, ctx.userId))) throw new Error();\n" +
          "};\n",
      ),
    ).toEqual([]);
  });

  it("passes a gate handed to the handler in a dependency object, one hop away", () => {
    expect(
      scan(
        'import { deps } from "./widget.deps";\n' +
          "export const widgetMakeHandler = async (_i, ctx) => deps().roles.orgRole(ctx.orgId);\n",
        {
          "widget.deps.ts":
            'import { resolveActorOrgRole } from "@oxagen/iam/org-role";\n' +
            "export function deps() { return { roles: { orgRole: resolveActorOrgRole } }; }\n",
        },
      ),
    ).toEqual([]);
  });

  it("passes an inline select of the membership role column", () => {
    expect(
      scan(
        "export const widgetMakeHandler = async () =>\n" +
          "  tx.select({ role: schema.orgUsers.role }).from(schema.orgUsers);\n",
      ),
    ).toEqual([]);
  });

  it("flags a high-sensitivity contract bound only in LOADERS whose handler has no gate", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "gadget.resolve.ts"),
      highContract("resolve_gadgets"),
    );
    writeFileSync(
      join(dirs.agentHandlersDir, "index.ts"),
      'const LOADERS = { resolve_gadgets: () => import("./gadget.resolve") };\n',
    );
    writeFileSync(
      join(dirs.agentHandlersDir, "gadget.resolve.ts"),
      "// Gated to members: assertOrgRole.\nexport async function gadgetResolveHandler() { return []; }\n",
    );
    const { gaps, checked } = findGaps({ ...dirs, baseline: new Set() });
    expect(checked).toBe(1);
    expect(gaps).toEqual([
      expect.objectContaining({
        name: "resolve_gadgets",
        rule: "high_sensitivity",
        handlerPath: join(dirs.agentHandlersDir, "gadget.resolve.ts"),
      }),
    ]);
  });

  it("flags a baseline stem whose contract no longer declares a restriction", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      'export const x = registerCapability({\n  name: "make_widget",\n  sensitivity: "low",\n});\n',
    );
    writeFileSync(
      join(dirs.handlersDir, "widget.make.ts"),
      "export const widgetMakeHandler = () => {};\n",
    );
    const { gaps, baselineHits, staleBaselineEntries } = findGaps({
      ...dirs,
      baseline: new Set(["widget.make"]),
    });
    expect(gaps).toEqual([]);
    expect(baselineHits).toEqual([]);
    expect(staleBaselineEntries).toEqual([
      {
        stem: "widget.make",
        name: "make_widget",
        reason: "the contract no longer declares a role restriction",
      },
    ]);
  });

  it("flags a baseline stem whose contract file is gone", () => {
    const dirs = setup();
    const { staleBaselineEntries } = findGaps({
      ...dirs,
      baseline: new Set(["widget.gone"]),
    });
    expect(staleBaselineEntries).toEqual([
      expect.objectContaining({ stem: "widget.gone" }),
    ]);
  });

  it("flags a baseline stem with no handler to read", () => {
    const dirs = setup();
    writeFileSync(
      join(dirs.contractsDir, "widget.make.ts"),
      highContract("make_widget"),
    );
    const { staleBaselineEntries } = findGaps({
      ...dirs,
      baseline: new Set(["widget.make"]),
    });
    expect(staleBaselineEntries).toEqual([
      expect.objectContaining({
        stem: "widget.make",
        reason: "no handler module is bound to the capability",
      }),
    ]);
  });
});
