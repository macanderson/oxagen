import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigScopePaths, clearWorkspaceConfigCache } from "../resolve.js";
import type { WorkspaceConfig, ConfigScope } from "../schema.js";
import { runConfigDoctor, formatDoctorReport, flattenScopePaths, type DoctorOptions } from "../doctor.js";

let cwd: string;
let homeDir: string;
let managedPath: string;
let userPath: string;

function opts(env: Record<string, string | undefined> = {}): DoctorOptions {
  return { managedConfigPath: managedPath, userConfigPath: userPath, noCache: true, env };
}

function write(scope: ConfigScope, body: WorkspaceConfig): void {
  const paths = getConfigScopePaths(cwd, { managedConfigPath: managedPath, userConfigPath: userPath });
  mkdirSync(join(paths[scope], ".."), { recursive: true });
  writeFileSync(paths[scope], JSON.stringify(body), "utf8");
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
    expect(paths.sort()).toEqual(["vcs.commit.convention", "vision.goals", "vision.statement"]);
  });
});

describe("runConfigDoctor — tier chain", () => {
  it("reports the four tiers most-specific-first with presence", () => {
    write("workspace", { workspaceSlug: "ws" });
    const report = runConfigDoctor(cwd, opts());
    expect(report.tiers.map((t) => t.scope)).toEqual(["repo", "workspace", "user", "org"]);
    expect(report.tiers.find((t) => t.scope === "workspace")?.present).toBe(true);
    expect(report.tiers.find((t) => t.scope === "org")?.present).toBe(false);
  });

  it("flags an unparseable scope file as an error finding", () => {
    const paths = getConfigScopePaths(cwd, { managedConfigPath: managedPath, userConfigPath: userPath });
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
    const overridden = report.findings.find((f) => f.title.includes("packageManagers.primary"));
    expect(overridden?.severity).toBe("warn");
    expect(overridden?.detail).toContain("org");
  });

  it("does not warn when the repo value simply wins as most specific", () => {
    write("user", { packageManagers: { primary: "pnpm" } });
    write("repo", { packageManagers: { primary: "bun" } });
    const report = runConfigDoctor(cwd, opts());
    expect(report.findings.some((f) => f.title.includes("overridden"))).toBe(false);
  });

  it("reports env vars that shadow file config", () => {
    write("workspace", { workspaceSlug: "ws" });
    const report = runConfigDoctor(cwd, opts({ OXAGEN_MODEL: "openai/gpt-5", OXAGEN_EFFORT: "high" }));
    const env = report.findings.find((f) => f.title.includes("Environment variables"));
    expect(env?.detail).toContain("OXAGEN_MODEL");
    expect(env?.detail).toContain("OXAGEN_EFFORT");
  });
});

describe("runConfigDoctor — recommendations", () => {
  it("recommends init when no project-level config exists", () => {
    const report = runConfigDoctor(cwd, opts());
    const finding = report.findings.find((f) => f.title.includes("No project-level config"));
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
      languages: { typescript: { items: [{ id: "no-any", kind: "rule", text: "no any", origin: "manual" }] } },
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
