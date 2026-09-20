import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  declaredCapabilityName,
  declaresRoleRestriction,
  findGaps,
  ROLE_ENFORCEMENT_BASELINE,
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
