import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseSource } from "./lib/role-gate-ast.mjs";
import {
  declaredCapabilityName,
  declaresAgentRoleRestriction,
  declaresRoleRestriction,
  findGaps,
  handlerAssertsRole,
  parseDefaultRoles,
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

describe("findGaps", () => {
  let dir: string;
  let contractsDir: string;
  let handlersDir: string;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function setup() {
    dir = mkdtempSync(join(tmpdir(), "role-enforcement-"));
    contractsDir = join(dir, "contracts");
    handlersDir = join(dir, "handlers");
    mkdirSync(contractsDir, { recursive: true });
    mkdirSync(handlersDir, { recursive: true });
    return { contractsDir, handlersDir };
  }

  function contract(name: string, restricted = true) {
    return restricted
      ? `export const x = registerCapability({\n  name: "${name}",\n  sensitivity: "high",\n  defaultRoles: {\n    org: { Owner: "allow" },\n  },\n});\n`
      : `export const x = registerCapability({\n  name: "${name}",\n  sensitivity: "low",\n});\n`;
  }

  it("flags a contract whose handler asserts no role", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      "export const h = () => {};\n",
    );
    const { gaps, baselineHits } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(),
    });
    expect(gaps).toEqual([
      expect.objectContaining({ stem: "widget.make", name: "make_widget" }),
    ]);
    expect(baselineHits).toEqual([]);
  });

  it("does not flag a handler that calls assertOrgRole", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      'import { assertOrgRole } from "@oxagen/iam/org-role";\nexport const h = async (i, ctx) => { await assertOrgRole(ctx, { org: ["Owner"] }); };\n',
    );
    const { gaps } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(),
    });
    expect(gaps).toEqual([]);
  });

  it("recognizes the existing contract-driven caller role guard", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      "export const h = async (i, ctx) => { await assertCallerRole(contract, ctx); };\n",
    );
    const { gaps, staleBaselineEntries } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(["widget.make"]),
    });
    expect(gaps).toEqual([]);
    expect(staleBaselineEntries).toEqual([
      expect.objectContaining({ stem: "widget.make" }),
    ]);
  });

  it("does not flag a handler that resolves the actor's role directly", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      'import { resolveActorOrgRole } from "@oxagen/iam/org-role";\nexport const h = async () => { await resolveActorOrgRole("o", "u"); };\n',
    );
    const { gaps } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(),
    });
    expect(gaps).toEqual([]);
  });

  it("does not flag a contract with no restrictive defaultRoles", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget", false),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      "export const h = () => {};\n",
    );
    const { gaps } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(),
    });
    expect(gaps).toEqual([]);
  });

  it("skips a contract with no handler at the conventional path", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    const { gaps } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(),
    });
    expect(gaps).toEqual([]);
  });

  it("reports a baseline stem separately from gaps and does not fail on it", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      "export const h = () => {};\n",
    );
    const { gaps, baselineHits } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(["widget.make"]),
    });
    expect(gaps).toEqual([]);
    expect(baselineHits).toEqual([
      { stem: "widget.make", name: "make_widget" },
    ]);
  });

  // Codex P2 on #3487: a baseline stem whose handler already asserts the
  // role is a stale exception, and leaving it in the list would let a
  // future regression (the assertion later deleted) silently fall back
  // into `baselineHits` as "already known" instead of failing the build.
  it("flags a baseline stem whose handler already asserts the role as stale", () => {
    setup();
    writeFileSync(
      join(contractsDir, "widget.make.ts"),
      contract("make_widget"),
    );
    writeFileSync(
      join(handlersDir, "widget.make.ts"),
      "export const h = (ctx) => { assertOrgRole(ctx, {}); };\n",
    );
    const { gaps, baselineHits, staleBaselineEntries } = findGaps({
      contractsDir,
      handlersDir,
      baseline: new Set(["widget.make"]),
    });
    expect(gaps).toEqual([]);
    expect(baselineHits).toEqual([]);
    expect(staleBaselineEntries).toEqual([
      {
        stem: "widget.make",
        name: "make_widget",
        reason: "the handler now calls a role gate",
      },
    ]);
  });
});

describe("against the real tree", () => {
  it("finds no gap outside the checked-in baseline (connection.create is fixed, #3258)", () => {
    const { gaps, staleBaselineEntries } = findGaps();
    expect(gaps).toEqual([]);
    expect(staleBaselineEntries).toEqual([]);
  });

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

  it("covers the thirty agent-surface contracts #4194 gated", () => {
    const { gaps, checked } = findGaps();
    expect(gaps).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(150);
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

describe("resolve_mcp_servers (#3490)", () => {
  const repoRoot = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );
  const handlersDir = join(repoRoot, "packages", "handlers", "src");
  const agentHandlersDir = join(
    repoRoot,
    "packages",
    "agent",
    "src",
    "handlers",
  );
  const parse = (file: string) =>
    parseSource(file, readFileSync(file, "utf8"));

  // Before #3490 the high-sensitivity rule read only
  // packages/handlers/src/agent.mcp.resolve.ts, which does not exist, so the
  // contract was skipped and every assertion below "not a gap" passed empty.
  // This one fails unless the check really reaches the packages/agent handler
  // and finds the gate in it.
  it("is resolved to its packages/agent handler, which calls a role gate", () => {
    const handler = resolveHandler({
      name: "resolve_mcp_servers",
      stem: "agent.mcp.resolve",
      registerSource: parse(join(handlersDir, "register.ts")),
      agentIndexSource: parse(join(agentHandlersDir, "index.ts")),
      handlersDir,
      agentHandlersDir,
    });
    expect(handler).toEqual({
      file: join(agentHandlersDir, "agent.mcp.resolve.ts"),
      exportName: "agentMcpResolveHandler",
    });
    expect(
      handler && handlerAssertsRole(handler.file, handler.exportName),
    ).toBe(true);
  });

  it("is neither a gap nor a baseline entry", () => {
    const { gaps, baselineHits } = findGaps();
    expect(gaps.map((g) => g.name)).not.toContain("resolve_mcp_servers");
    expect(baselineHits.map((g) => g.name)).not.toContain(
      "resolve_mcp_servers",
    );
    expect(ROLE_ENFORCEMENT_BASELINE.has("agent.mcp.resolve")).toBe(false);
  });
});
