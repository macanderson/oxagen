// These tests read the real contracts and handlers in packages/oxagen,
// packages/handlers and packages/agent. vitest.config.ts leaves *.tree.test.ts
// files out of turbo's cached tasks, so `pnpm check:tree-guards` runs them
// uncached in the checks job (#4664 item 2).
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
  findGaps,
  handlerAssertsRole,
  resolveHandler,
  ROLE_ENFORCEMENT_BASELINE,
} from "./check-role-enforcement.mjs";

// These fixture cases leave agentHandlersDir unset, so findGaps also reads
// the real packages/agent/src/handlers/index.ts.
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
});

describe("the #4194 baseline and coverage", () => {
  it("covers the thirty agent-surface contracts #4194 gated", () => {
    const { gaps, checked } = findGaps();
    expect(gaps).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(150);
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
