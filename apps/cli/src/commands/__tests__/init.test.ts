/**
 * Unit tests for `oxagen init` — settings scaffolding + summary formatting.
 *
 * Narrow scope per CLAUDE.md: tests cover only the pure functions exposed by
 * init.ts (settings file creation/merge and summary rendering).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSettingsFiles,
  formatInitSummary,
  runInit,
  type InitResult,
  type InitProgressEvent,
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
    workspaceLink: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Settings scaffolding
// ---------------------------------------------------------------------------

describe("ensureSettingsFiles", () => {
  it("creates both project and user settings files when they do not exist", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.userCreated).toBe(true);
    expect(result.projectCreated).toBe(true);
    expect(existsSync(result.userPath)).toBe(true);
    expect(existsSync(result.projectPath)).toBe(true);
  });

  it("writes valid JSON to both files", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });

    const projectRaw = readFileSync(
      join(tmpDir, ".oxagen", "settings.json"),
      "utf8",
    );
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
      $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
      model: "my-custom-model",
      permissions: {
        allow: ["Bash(git*)"],
        deny: [],
      },
    });
    writeFileSync(projectPath, customContent, "utf8");

    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

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
      $schema: "https://schemas.oxagen.sh/oxagen-cli-settings-schema.json",
      model: "my-global-model",
    });
    writeFileSync(userPath, customUserContent, "utf8");

    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.userCreated).toBe(false);
    const after = readFileSync(userPath, "utf8");
    const parsed = JSON.parse(after) as Record<string, unknown>;
    expect(parsed["model"]).toBe("my-global-model");
  });

  it("returns correct paths", () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(result.projectPath).toBe(join(tmpDir, ".oxagen", "settings.json"));
    expect(result.userPath).toBe(userPath);
  });

  it("is idempotent — second call reports created:false for both", () => {
    const userPath = join(tmpDir, "user-settings.json");
    ensureSettingsFiles({ cwd: tmpDir, userSettingsPath: userPath });
    const second = ensureSettingsFiles({
      cwd: tmpDir,
      userSettingsPath: userPath,
    });

    expect(second.projectCreated).toBe(false);
    expect(second.userCreated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// formatInitSummary
// ---------------------------------------------------------------------------

describe("formatInitSummary", () => {
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

  it("shows precedence note for settings tiers", () => {
    const summary = formatInitSummary(makeResult());
    expect(summary).toContain("global");
    expect(summary).toContain("project");
    expect(summary).toContain("local");
  });

  it("renders the linked workspace when the linker ran", () => {
    const summary = formatInitSummary(
      makeResult({
        workspaceLink: {
          linked: true,
          orgSlug: "acme",
          orgName: "Acme",
          workspaceSlug: "core",
          workspaceName: "Core",
          repos: [{ provider: "github", fullName: "acme/repo" }],
        },
      }),
    );
    expect(summary).toContain("Acme / Core");
    expect(summary).toContain("acme/repo");
  });

  it("renders the skip reason when linking was skipped", () => {
    const summary = formatInitSummary(
      makeResult({
        workspaceLink: { linked: false, skippedReason: "No platform session." },
      }),
    );
    expect(summary).toContain("No platform session.");
  });
});

// ---------------------------------------------------------------------------
// runInit — onProgress
// ---------------------------------------------------------------------------

describe("runInit onProgress", () => {
  it("emits real phase-boundary events in order with no link", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const events: InitProgressEvent[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });

    expect(events.map((e) => `${e.phase}:${e.status}`)).toEqual([
      "settings:start",
      "settings:done",
    ]);
  });

  it("never emits a link event when noLink is set", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const events: InitProgressEvent[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: (e) => {
        events.push(e);
      },
    });

    expect(events.some((e) => e.phase === "link")).toBe(false);
  });

  it("awaits an async onProgress callback between phases", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const seen: string[] = [];

    await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
      onProgress: async (e) => {
        // A real await gap — if runInit forgot to await onProgress, phases
        // could interleave with this resolving late instead of in order.
        await new Promise((r) => setTimeout(r, 1));
        seen.push(`${e.phase}:${e.status}`);
      },
    });

    expect(seen).toEqual(["settings:start", "settings:done"]);
  });

  it("behaves identically when onProgress is omitted", async () => {
    const userPath = join(tmpDir, "user-settings.json");
    const result = await runInit({
      cwd: tmpDir,
      userSettingsPath: userPath,
      noLink: true,
    });
    expect(result.projectSettingsCreated).toBe(true);
  });
});
