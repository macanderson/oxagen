import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaredCapabilityName,
  declaresAgentRoleRestriction,
  declaresRoleRestriction,
  findGaps,
  handlerModules,
  parseDefaultRoles,
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
      { stem: "widget.make", name: "make_widget" },
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

describe("handlerModules", () => {
  it("reads register.ts bindings and the agent LOADERS map", () => {
    const modules = handlerModules({
      registerSrc: `registerHandler(\n  "make_widget",\n  async () =>\n    (await import("./widget.build")).widgetBuildHandler as CapabilityHandlerFn,\n);`,
      registerDir: "/h",
      agentIndexSrc: `const LOADERS = {\n  list_gadgets: () => import("./gadget.list"),\n  fetch_gizmo: () =>\n    import("./gizmo.fetch"),\n};`,
      agentDir: "/a",
    });
    expect(Object.fromEntries(modules)).toEqual({
      make_widget: "/h/widget.build",
      list_gadgets: "/a/gadget.list",
      fetch_gizmo: "/a/gizmo.fetch",
    });
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
