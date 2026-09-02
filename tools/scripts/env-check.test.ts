import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PLATFORM_ALLOWLIST,
  type EnvCheckReport,
  type ReconcileInput,
  reconcile,
  scanSourceReferences,
} from "./env-check";

// ── reconcile fixtures ────────────────────────────────────────────────────────

function makeInput(overrides: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    referenced: new Map(),
    registryKeySet: new Set([
      "DATABASE_URL",
      "LOG_LEVEL",
      "AI_GATEWAY_API_KEY",
      "VERCEL_TOKEN",
    ]),
    schemaKeySet: new Set(["DATABASE_URL"]),
    // DATABASE_URL → api,app,mcp (has services)
    // LOG_LEVEL → api,app,mcp (has services, unvalidated)
    // AI_GATEWAY_API_KEY → api,app,mcp (has services — potentially dead)
    // VERCEL_TOKEN → [] (tooling-only, no services)
    registryServiceMap: new Map([
      ["DATABASE_URL", ["api", "app", "mcp"]],
      ["LOG_LEVEL", ["api", "app", "mcp"]],
      ["AI_GATEWAY_API_KEY", ["api", "app", "mcp"]],
      ["VERCEL_TOKEN", []],
    ]),
    loadEnvFound: false,
    ...overrides,
  };
}

describe("reconcile — ok classification", () => {
  it("a schema-validated key referenced in code → ok", () => {
    const input = makeInput({
      referenced: new Map([
        ["DATABASE_URL", ["packages/database/src/client.ts:13"]],
      ]),
    });
    const report = reconcile(input);
    expect(report.ok).toHaveLength(1);
    expect(report.ok[0]!.key).toBe("DATABASE_URL");
    expect(report.fail).toHaveLength(0);
    expect(report.warnUnvalidated).toHaveLength(0);
  });
});

describe("reconcile — warnUnvalidated classification", () => {
  it("in-registry-but-not-schema key → warnUnvalidated (not fail)", () => {
    const input = makeInput({
      referenced: new Map([
        ["LOG_LEVEL", ["packages/agent/src/hooks/runtime.ts:5"]],
      ]),
    });
    const report = reconcile(input);
    expect(report.warnUnvalidated).toHaveLength(1);
    expect(report.warnUnvalidated[0]!.key).toBe("LOG_LEVEL");
    expect(report.fail).toHaveLength(0);
  });
});

describe("reconcile — fail classification", () => {
  it("key referenced in code, absent from registry and not allowlisted → fail", () => {
    const input = makeInput({
      referenced: new Map([["ZZZ_BOGUS_VAR", ["packages/foo/src/bar.ts:10"]]]),
    });
    const report = reconcile(input);
    expect(report.fail).toHaveLength(1);
    expect(report.fail[0]!.key).toBe("ZZZ_BOGUS_VAR");
    expect(report.fail[0]!.locations).toEqual(["packages/foo/src/bar.ts:10"]);
  });

  it("exit-1 condition: fail is non-empty", () => {
    const input = makeInput({
      referenced: new Map([["TOTALLY_UNKNOWN", ["some/file.ts:1"]]]),
    });
    const report = reconcile(input);
    expect(report.fail.length).toBeGreaterThan(0);
  });
});

describe("reconcile — warnDead classification", () => {
  it("in-registry-with-services but not referenced → warnDead", () => {
    const input = makeInput({ referenced: new Map() });
    const report = reconcile(input);
    // AI_GATEWAY_API_KEY has services but is not referenced
    expect(report.warnDead.some((f) => f.key === "AI_GATEWAY_API_KEY")).toBe(
      true,
    );
    // DATABASE_URL also has services and isn't referenced in this fixture
    expect(report.warnDead.some((f) => f.key === "DATABASE_URL")).toBe(true);
  });

  it("tooling-only (services: []) vars are NOT in warnDead even if unreferenced", () => {
    const input = makeInput({ referenced: new Map() });
    const report = reconcile(input);
    expect(report.warnDead.some((f) => f.key === "VERCEL_TOKEN")).toBe(false);
  });
});

describe("reconcile — loadEnv suppresses dead warnings for schema keys", () => {
  it("when loadEnvFound=true, schema keys are implicitly consumed → not dead", () => {
    const input = makeInput({ referenced: new Map(), loadEnvFound: true });
    const report = reconcile(input);
    // DATABASE_URL is in schemaKeySet → implicitly consumed → not dead
    expect(report.warnDead.some((f) => f.key === "DATABASE_URL")).toBe(false);
    // AI_GATEWAY_API_KEY is NOT in schemaKeySet → still dead
    expect(report.warnDead.some((f) => f.key === "AI_GATEWAY_API_KEY")).toBe(
      true,
    );
  });
});

describe("reconcile — PLATFORM_ALLOWLIST", () => {
  it("allowlisted keys are silently ignored even if referenced", () => {
    const input = makeInput({
      referenced: new Map([
        ["VERCEL_ENV", ["packages/auth/src/auth.ts:43"]],
        ["NEXT_PHASE", ["packages/auth/src/auth.ts:56"]],
        ["CI", [".github/workflows/ci.yml:1"]],
        ["NEO4J_URL", ["apps/app/e2e/fixture.ts:10"]],
      ]),
    });
    const report = reconcile(input);
    const allKeys = [
      ...report.ok,
      ...report.warnUnvalidated,
      ...report.fail,
      ...report.warnDead,
    ].map((f) => f.key);
    for (const k of ["VERCEL_ENV", "NEXT_PHASE", "CI", "NEO4J_URL"]) {
      expect(allKeys, `${k} should be silently ignored`).not.toContain(k);
    }
  });

  it("PLATFORM_ALLOWLIST contains all expected platform vars", () => {
    for (const k of [
      "VERCEL_ENV",
      "VERCEL_URL",
      "VERCEL",
      "NEXT_RUNTIME",
      "NEXT_PHASE",
      "CI",
      "PLATFORM_VERSION",
      "TURBO_TOKEN",
      "TURBO_TEAM",
      "E2E_TEST",
      "PLAYWRIGHT_BASE_URL",
      "NEO4J_URL",
      "NEO4J_USER",
    ]) {
      expect(
        PLATFORM_ALLOWLIST.has(k),
        `${k} should be in PLATFORM_ALLOWLIST`,
      ).toBe(true);
    }
  });
});

describe("reconcile — empty referenced map → only dead warnings (no fail)", () => {
  it("no references, no fails; only dead warnings for service-bearing entries", () => {
    const input = makeInput({ referenced: new Map() });
    const report: EnvCheckReport = reconcile(input);
    expect(report.fail).toHaveLength(0);
    expect(report.ok).toHaveLength(0);
  });
});

// ── scanSourceReferences ─────────────────────────────────────────────────────

describe("scanSourceReferences", () => {
  it("finds process.env.KEY references and records file:line", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(
        join(dir, "test.ts"),
        `const a = process.env.FOO_BAR;\nconst b = process.env.BAZ_QUX;\n`,
      );
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("FOO_BAR")).toBe(true);
      expect(result.referenced.has("BAZ_QUX")).toBe(true);
      expect(result.referenced.get("FOO_BAR")![0]).toMatch(/test\.ts:1$/);
      expect(result.referenced.get("BAZ_QUX")![0]).toMatch(/test\.ts:2$/);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("finds bracket-notation references", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(
        join(dir, "test.ts"),
        `const x = process.env["MY_SECRET"];\n`,
      );
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("MY_SECRET")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("finds requireEnv array keys (single-line)", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(
        join(dir, "test.ts"),
        `const env = requireEnv(["DATABASE_URL", "NODE_ENV"]);\n`,
      );
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("DATABASE_URL")).toBe(true);
      expect(result.referenced.has("NODE_ENV")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("finds requireEnv array keys (multi-line)", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(
        join(dir, "test.ts"),
        `const env = requireEnv([\n  "STRIPE_SECRET_KEY",\n  "STRIPE_WEBHOOK_SECRET",\n]);\n`,
      );
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("STRIPE_SECRET_KEY")).toBe(true);
      expect(result.referenced.has("STRIPE_WEBHOOK_SECRET")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("detects loadEnv() calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(join(dir, "test.ts"), `const env = loadEnv();\n`);
      const result = scanSourceReferences([dir]);
      expect(result.loadEnvFound).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("skips test files (*.test.ts, *.spec.ts)", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      writeFileSync(
        join(dir, "foo.test.ts"),
        `process.env.SHOULD_SKIP_THIS;\n`,
      );
      writeFileSync(join(dir, "bar.spec.ts"), `process.env.ALSO_SKIP;\n`);
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("SHOULD_SKIP_THIS")).toBe(false);
      expect(result.referenced.has("ALSO_SKIP")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("skips node_modules and .next directories", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      mkdirSync(join(dir, "node_modules"));
      writeFileSync(
        join(dir, "node_modules", "dep.ts"),
        `process.env.SKIP_NODE_MODULES;\n`,
      );
      mkdirSync(join(dir, ".next"));
      writeFileSync(join(dir, ".next", "out.ts"), `process.env.SKIP_NEXT;\n`);
      writeFileSync(join(dir, "real.ts"), `process.env.SHOULD_FIND;\n`);
      const result = scanSourceReferences([dir]);
      expect(result.referenced.has("SKIP_NODE_MODULES")).toBe(false);
      expect(result.referenced.has("SKIP_NEXT")).toBe(false);
      expect(result.referenced.has("SHOULD_FIND")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("handles empty root gracefully (no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-check-test-"));
    try {
      const result = scanSourceReferences([dir]);
      expect(result.referenced.size).toBe(0);
      expect(result.loadEnvFound).toBe(false);
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("returns empty for a non-existent root (no throw)", () => {
    const result = scanSourceReferences(["/tmp/does-not-exist-env-check-test"]);
    expect(result.referenced.size).toBe(0);
  });
});
