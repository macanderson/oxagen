import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigScopePaths, clearWorkspaceConfigCache } from "../resolve.js";
import type { WorkspaceConfig, ConfigScope } from "../schema.js";
import {
  runConfigDoctor,
  formatDoctorReport,
  flattenScopePaths,
  type DoctorOptions,
} from "../doctor.js";

let cwd: string;
let homeDir: string;
let managedPath: string;
let userPath: string;

function opts(env: Record<string, string | undefined> = {}): DoctorOptions {
  // userSettingsPath keeps runConfigDoctor's settings.env diffing (item 7b)
  // from ever touching the real $HOME/.oxagen/settings.json during tests.
  return {
    managedConfigPath: managedPath,
    userConfigPath: userPath,
    userSettingsPath: join(homeDir, "settings.json"),
    noCache: true,
    env,
  };
}

function write(scope: ConfigScope, body: WorkspaceConfig): void {
  const paths = getConfigScopePaths(cwd, {
    managedConfigPath: managedPath,
    userConfigPath: userPath,
  });
  mkdirSync(join(paths[scope], ".."), { recursive: true });
  writeFileSync(paths[scope], JSON.stringify(body), "utf8");
}

/** Writes <cwd>/.oxagen/settings.json (project-scope settings.json — a different file from workspace.json/repo.json). */
function writeProjectSettings(body: Record<string, unknown>): void {
  const dir = join(cwd, ".oxagen");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(body), "utf8");
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-doctor-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-doctor-home-"));
  managedPath = join(homeDir, "managed.json");
  userPath = join(homeDir, "user.json");
  clearWorkspaceConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  clearWorkspaceConfigCache();
});

describe("flattenScopePaths", () => {
  it("returns dotted leaf paths, treating arrays as leaves and skipping meta keys", () => {
    const paths = flattenScopePaths({
      $schema: "x",
      version: 1,
      locked: ["vcs"],
      vision: { statement: "ship", goals: ["a", "b"] },
      vcs: { commit: { convention: "cc" } },
    } as WorkspaceConfig);
    expect(paths.sort()).toEqual([
      "vcs.commit.convention",
      "vision.goals",
      "vision.statement",
    ]);
  });
});

describe("runConfigDoctor — tier chain", () => {
  it("reports the four tiers most-specific-first with presence", () => {
    write("workspace", { workspaceSlug: "ws" });
    const report = runConfigDoctor(cwd, opts());
    expect(report.tiers.map((t) => t.scope)).toEqual([
      "repo",
      "workspace",
      "user",
      "org",
    ]);
    expect(report.tiers.find((t) => t.scope === "workspace")?.present).toBe(
      true,
    );
    expect(report.tiers.find((t) => t.scope === "org")?.present).toBe(false);
  });

  it("flags an unparseable scope file as an error finding", () => {
    const paths = getConfigScopePaths(cwd, {
      managedConfigPath: managedPath,
      userConfigPath: userPath,
    });
    mkdirSync(join(paths.repo, ".."), { recursive: true });
    writeFileSync(paths.repo, "{ not json", "utf8");
    const report = runConfigDoctor(cwd, opts());
    const error = report.findings.find((f) => f.severity === "error");
    expect(error?.title).toContain("repo config is invalid");
  });
});

describe("runConfigDoctor — governance and shadowing", () => {
  it("warns when a repo value is silently overridden by the org managed tier", () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    write("repo", { packageManagers: { primary: "npm" } });
    const report = runConfigDoctor(cwd, opts());
    const overridden = report.findings.find((f) =>
      f.title.includes("packageManagers.primary"),
    );
    expect(overridden?.severity).toBe("warn");
    expect(overridden?.detail).toContain("org");
  });

  it("does not warn when the repo value simply wins as most specific", () => {
    write("user", { packageManagers: { primary: "pnpm" } });
    write("repo", { packageManagers: { primary: "bun" } });
    const report = runConfigDoctor(cwd, opts());
    expect(report.findings.some((f) => f.title.includes("overridden"))).toBe(
      false,
    );
  });

  it("reports env vars that shadow file config", () => {
    write("workspace", { workspaceSlug: "ws" });
    const report = runConfigDoctor(
      cwd,
      opts({ OXAGEN_MODEL: "openai/gpt-5", OXAGEN_EFFORT: "high" }),
    );
    const env = report.findings.find((f) =>
      f.title.includes("Environment variables"),
    );
    expect(env?.detail).toContain("OXAGEN_MODEL");
    expect(env?.detail).toContain("OXAGEN_EFFORT");
  });

  // Item 7b: doctor used to check a FIXED 7-var list and never loaded
  // settings.json at all, so a `settings set env.MY_KEY <value>` shadowed by
  // the shell had no way to surface here. Now every declared settings.env key
  // (plus model/apiUrl) is diffed against the live environment, per key.
  describe("settings.env precedence diffing", () => {
    it("warns per-key when the shell shadows a declared settings.env value, naming the scope", () => {
      writeProjectSettings({ env: { MY_TOKEN: "from-settings" } });
      const report = runConfigDoctor(cwd, opts({ MY_TOKEN: "from-shell" }));
      const finding = report.findings.find((f) => f.title.includes("MY_TOKEN"));
      expect(finding?.severity).toBe("warn");
      expect(finding?.detail).toContain("project settings");
      expect(finding?.detail).toContain("MY_TOKEN");
    });

    it("does not warn when the shell does not export a declared settings.env key", () => {
      writeProjectSettings({ env: { MY_TOKEN: "from-settings" } });
      const report = runConfigDoctor(cwd, opts({}));
      expect(report.findings.some((f) => f.title.includes("MY_TOKEN"))).toBe(
        false,
      );
    });

    it("diffs settings.model against OXAGEN_MODEL specifically (not just the generic env list)", () => {
      writeProjectSettings({ model: "vendor/from-settings" });
      const report = runConfigDoctor(
        cwd,
        opts({ OXAGEN_MODEL: "vendor/from-shell" }),
      );
      const finding = report.findings.find((f) =>
        f.title.includes("OXAGEN_MODEL"),
      );
      expect(finding?.severity).toBe("warn");
      expect(finding?.detail).toContain("project settings");
      // Superseded by the per-key finding — no longer double-reported in the
      // generic "Environment variables are overriding file config" bucket.
      const generic = report.findings.find((f) =>
        f.title.includes("Environment variables are overriding"),
      );
      expect(generic?.detail ?? "").not.toContain("OXAGEN_MODEL");
    });

    it("still reports OXAGEN_EFFORT (no settings.json equivalent) via the generic fallback list", () => {
      writeProjectSettings({ model: "vendor/from-settings" });
      const report = runConfigDoctor(
        cwd,
        opts({ OXAGEN_MODEL: "vendor/from-shell", OXAGEN_EFFORT: "high" }),
      );
      const generic = report.findings.find((f) =>
        f.title.includes("Environment variables are overriding"),
      );
      expect(generic?.detail).toContain("OXAGEN_EFFORT");
    });
  });
});

describe("formatDoctorReport — precedence table (item 10)", () => {
  it("prints the real, code-verified precedence for model/apiUrl, settings.env, and workspace config", () => {
    const text = formatDoctorReport(runConfigDoctor(cwd, opts()));
    expect(text).toContain("Effective precedence (highest wins):");
    expect(text).toContain("OXAGEN_MODEL");
    expect(text).toContain("settings.local.json");
    expect(text).toContain("config.json (store #2)");
    expect(text).toContain("managed.json (org, always locked)");
  });
});

describe("runConfigDoctor — recommendations", () => {
  it("recommends init when no project-level config exists", () => {
    const report = runConfigDoctor(cwd, opts());
    const finding = report.findings.find((f) =>
      f.title.includes("No project-level config"),
    );
    expect(finding?.severity).toBe("warn");
    expect(finding?.fix).toContain("oxagen init");
  });

  it("recommends vision, commands, and language rules for a bare workspace file", () => {
    write("workspace", { workspaceSlug: "ws" });
    const titles = runConfigDoctor(cwd, opts()).findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("vision statement"))).toBe(true);
    expect(titles.some((t) => t.includes("No project commands"))).toBe(true);
    expect(titles.some((t) => t.includes("per-language rules"))).toBe(true);
  });

  it("suppresses recommendations that are already satisfied", () => {
    write("workspace", {
      workspaceSlug: "ws",
      vision: { statement: "ship it" },
      commands: { test: [{ run: "pnpm test" }] },
      languages: {
        typescript: {
          items: [
            { id: "no-any", kind: "rule", text: "no any", origin: "manual" },
          ],
        },
      },
    });
    const titles = runConfigDoctor(cwd, opts()).findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("vision statement"))).toBe(false);
    expect(titles.some((t) => t.includes("No project commands"))).toBe(false);
    expect(titles.some((t) => t.includes("per-language rules"))).toBe(false);
  });

  it("notes when org-managed settings are absent and how to pull them", () => {
    write("workspace", { workspaceSlug: "ws" });
    const finding = runConfigDoctor(cwd, opts()).findings.find((f) =>
      f.title.includes("org-managed settings"),
    );
    expect(finding?.fix).toContain("oxagen config pull");
  });
});

describe("formatDoctorReport", () => {
  it("renders the tier chain and severity-ordered findings", () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    write("repo", { packageManagers: { primary: "npm" } });
    const text = formatDoctorReport(runConfigDoctor(cwd, opts()));
    expect(text).toContain("tier chain");
    expect(text).toContain("org (managed, enforced)");
    expect(text).toContain("⚠");
    // Warnings sort above infos.
    expect(text.indexOf("overridden")).toBeLessThan(text.indexOf("ℹ"));
  });
});
