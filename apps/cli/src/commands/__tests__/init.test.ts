/**
 * Unit tests for `oxagen init` — settings scaffolding + summary formatting.
 *
 * Narrow scope per CLAUDE.md: tests cover only the pure functions exposed by
 * init.ts (settings file creation/merge and summary rendering). Code-graph
 * building is covered by the daemon/code-graph builder tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSettingsFiles,
  formatInitSummary,
  type InitResult,
} from "../init.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "oxagen-init-test-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// Build a minimal InitResult suitable for rendering tests
function makeResult(overrides: Partial<InitResult> = {}): InitResult {
  return {
    projectSettingsPath: join(tmpDir, ".oxagen", "settings.json"),
    projectSettingsCreated: true,
    userSettingsPath: join(tmpDir, "user-settings.json"),
    userSettingsCreated: true,
    graph: {
      files: 42,
      totalSymbols: 120,
      totalEdges: 87,
      symbolsByKind: { function: 60, class: 20, interface: 15, type: 25 },
      edgesByType: { contains: 55, calls: 20, imports: 12 },
      languages: ["typescript", "javascript"],
      indexed: 40,
      skipped: 2,
    },
    domains: [
      { name: "billing", files: 12 },
      { name: "auth", files: 8 },
      { name: "graph", files: 5 },
    ],
    domainsSkipped: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Settings scaffolding
// ---------------------------------------------------------------------------

describe("ensureSettingsFiles", () => {
  it("creates both project and user settings files when they do not exist", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    expect(result.userCreated).toBe(true);
    expect(result.projectCreated).toBe(true);
    expect(existsSync(result.userPath)).toBe(true);
    expect(existsSync(result.projectPath)).toBe(true);
  });

  it("writes valid JSON to both files", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    const projectRaw = readFileSync(join(tmpDir, ".oxagen", "settings.json"), "utf8");
    const userRaw = readFileSync(userPath, "utf8");

    const project = JSON.parse(projectRaw) as Record<string, unknown>;
    const user = JSON.parse(userRaw) as Record<string, unknown>;

    // Both should have the starter $schema field
    expect(project["$schema"]).toContain("oxagen.sh");
    expect(user["$schema"]).toContain("oxagen.sh");
  });

  it("does not clobber existing project settings", () => {
    const userPath = join(tmpDir, "user-settings.json");
    // Pre-create the .oxagen dir + settings with custom content
    const oxagenDir = join(tmpDir, ".oxagen");
    mkdirSync(oxagenDir, { recursive: true });
    const projectPath = join(oxagenDir, "settings.json");
    const customContent = JSON.stringify({
      $schema: "https://oxagen.sh/schemas/cli-settings.json",
      model: "my-custom-model",
      permissions: {
        allow: ["Bash(git*)"],
        deny: [],
      },
    });
    writeFileSync(projectPath, customContent, "utf8");

    const result = ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    expect(result.projectCreated).toBe(false);
    // Original content must be preserved
    const after = readFileSync(projectPath, "utf8");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    expect(parsed["model"]).toBe("my-custom-model");
    const perms = parsed["permissions"] as Record<string, unknown>;
    expect(perms["allow"]).toContain("Bash(git*)");
  });

  it("does not clobber existing user settings", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const customUserContent = JSON.stringify({
      $schema: "https://oxagen.sh/schemas/cli-settings.json",
      model: "my-global-model",
    });
    writeFileSync(userPath, customUserContent, "utf8");

    const result = ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    expect(result.userCreated).toBe(false);
    const after = readFileSync(userPath, "utf8");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    expect(parsed["model"]).toBe("my-global-model");
  });

  it("returns correct paths", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    expect(result.projectPath).toBe(join(tmpDir, ".oxagen", "settings.json"));
    expect(result.userPath).toBe(userPath);
  });

  it("is idempotent — second call reports created:false for both", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });
    const second = ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    expect(second.projectCreated).toBe(false);
    expect(second.userCreated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatInitSummary
// ---------------------------------------------------------------------------

describe("formatInitSummary", () => {
  it("includes file, symbol, and edge counts", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("42 files");
    expect(summary).toContain("120 symbols");
    expect(summary).toContain("87 edges");
  });

  it("lists all inferred domains", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("billing");
    expect(summary).toContain("auth");
    expect(summary).toContain("graph");
  });

  it("shows per-domain file counts", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("12");
    expect(summary).toContain("8");
    expect(summary).toContain("5");
  });

  it("shows graceful 'skipped' message when domainsSkipped=true", () => {
    const summary = formatInitSummary(makeResult({ domains: null, domainsSkipped: true }));
    expect(summary).toContain("skipped");
    expect(summary).toContain("oxagen login");
  });

  it("shows 'none inferred' when domains empty + not skipped", () => {
    const summary = formatInitSummary(makeResult({ domains: [], domainsSkipped: false }));
    expect(summary).toContain("none inferred");
  });

  it("shows 'Created' for newly created settings files", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("Created");
  });

  it("shows 'Found' for pre-existing settings files", () => {
    const summary = formatInitSummary(
      makeResult({ projectSettingsCreated: false, userSettingsCreated: false }),
    );
    expect(summary).toContain("Found");
  });

  it("lists detected languages", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("typescript");
    expect(summary).toContain("javascript");
  });

  it("includes symbol kinds", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("function:60");
    expect(summary).toContain("class:20");
  });

  it("includes edge types", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("contains:55");
    expect(summary).toContain("calls:20");
  });

  it("shows precedence note for settings tiers", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("global");
    expect(summary).toContain("project");
    expect(summary).toContain("local");
  });
});
