import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveWorkspaceConfig,
  explain,
  getConfigScopePaths,
  clearWorkspaceConfigCache,
  mergeWorkspaceConfigs,
  type ResolveWorkspaceConfigOptions,
} from "../resolve.js";
import type { WorkspaceConfig, ConfigScope } from "../schema.js";

let cwd: string;
let homeDir: string;
let managedPath: string;
let userPath: string;

function opts(): ResolveWorkspaceConfigOptions {
  return {
    managedConfigPath: managedPath,
    userConfigPath: userPath,
    noCache: true,
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

function resolve() {
  return resolveWorkspaceConfig(cwd, opts());
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "oxagen-config-cwd-"));
  homeDir = mkdtempSync(join(tmpdir(), "oxagen-config-home-"));
  managedPath = join(homeDir, "managed.json");
  userPath = join(homeDir, "user.json");
  clearWorkspaceConfigCache();
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  clearWorkspaceConfigCache();
});

describe("resolveWorkspaceConfig — no files", () => {
  it("returns an empty config when no scope files exist", () => {
    const r = resolve();
    expect(r.config).toEqual({});
    expect(
      r.scopes.every((s) => s.config === undefined && s.error === undefined),
    ).toBe(true);
  });
});

describe("resolveWorkspaceConfig — scalar precedence", () => {
  it("most-specific wins for an unlocked leaf: workspace beats user", () => {
    // org is excluded here — it is *always* implicitly locked (see the
    // "locked / managed authority" describe block below), so this case
    // isolates pure specificity ordering among the non-authoritative scopes.
    write("user", { packageManagers: { primary: "yarn" } });
    write("workspace", { packageManagers: { primary: "pnpm" } });
    const r = resolve();
    expect(r.config.packageManagers?.primary).toBe("pnpm");
    expect(r.provenance["packageManagers.primary"]).toEqual({
      scope: "workspace",
      locked: false,
      reason: "most-specific",
    });
  });

  it("repo beats workspace when repo is the most specific scope set", () => {
    write("workspace", { packageManagers: { primary: "pnpm" } });
    write("repo", { packageManagers: { primary: "npm" } });
    expect(resolve().config.packageManagers?.primary).toBe("npm");
  });

  it("sibling sub-paths from different scopes compose instead of clobbering", () => {
    write("org", { vcs: { branch: { protected: ["main"] } } });
    write("workspace", { vcs: { commit: { convention: "conventional" } } });
    const r = resolve();
    expect(r.config.vcs?.branch?.protected).toEqual(["main"]);
    expect(r.config.vcs?.commit?.convention).toBe("conventional");
  });
});

describe("resolveWorkspaceConfig — locked / managed authority", () => {
  it("managed.json wins over a more specific unlocked scope (implicit org lock)", () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    write("workspace", { packageManagers: { primary: "npm" } });
    const r = resolve();
    expect(r.config.packageManagers?.primary).toBe("pnpm");
    expect(r.provenance["packageManagers.primary"]).toEqual({
      scope: "org",
      locked: true,
      reason: "managed",
    });
  });

  it("an explicit locked declaration at user scope beats a more specific unlocked workspace value", () => {
    write("user", {
      packageManagers: { primary: "yarn" },
      locked: ["packageManagers.primary"],
    });
    write("workspace", { packageManagers: { primary: "pnpm" } });
    const r = resolve();
    expect(r.config.packageManagers?.primary).toBe("yarn");
    expect(r.provenance["packageManagers.primary"]).toEqual({
      scope: "user",
      locked: true,
      reason: "locked",
    });
  });

  it("locking a parent path locks every leaf beneath it", () => {
    write("user", {
      vcs: { branch: { protected: ["main"], convention: "{type}/{slug}" } },
      locked: ["vcs.branch"],
    });
    write("workspace", { vcs: { branch: { protected: ["main", "develop"] } } });
    const r = resolve();
    expect(r.config.vcs?.branch?.protected).toEqual(["main"]);
    expect(r.provenance["vcs.branch.protected"]).toMatchObject({
      scope: "user",
      locked: true,
      reason: "locked",
    });
  });

  it("does not let an unrelated lock declaration affect a different path", () => {
    write("user", {
      vcs: { commit: { convention: "conventional" } },
      locked: ["vcs.branch"],
    });
    write("workspace", { vcs: { commit: { convention: "custom" } } });
    // "vcs.branch" is locked, not "vcs.commit.convention" — workspace should still win here.
    expect(resolve().config.vcs?.commit?.convention).toBe("custom");
  });
});

describe("resolveWorkspaceConfig — languages[*].items accumulate", () => {
  it("unions items across scopes by id when there is no collision", () => {
    write("user", {
      languages: {
        typescript: {
          items: [
            {
              id: "prefer-const",
              kind: "preference",
              text: "Prefer const.",
              origin: "manual",
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [
            { id: "no-any", kind: "rule", text: "No any.", origin: "manual" },
          ],
        },
      },
    });
    const ids = resolve()
      .config.languages?.typescript?.items?.map((i) => i.id)
      .sort();
    expect(ids).toEqual(["no-any", "prefer-const"]);
  });

  it("collision: most specific wins when neither entry is locked/enforced", () => {
    write("user", {
      languages: {
        typescript: {
          items: [
            {
              id: "quotes",
              kind: "convention",
              text: "single (user)",
              origin: "manual",
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [
            {
              id: "quotes",
              kind: "convention",
              text: "double (workspace)",
              origin: "manual",
            },
          ],
        },
      },
    });
    const r = resolve();
    const item = r.config.languages?.typescript?.items?.find(
      (i) => i.id === "quotes",
    );
    expect(item?.text).toBe("double (workspace)");
    expect(r.provenance["languages.typescript.items.quotes"]).toEqual({
      scope: "workspace",
      locked: false,
      reason: "most-specific",
    });
  });

  it("collision: a locked item beats a more specific unlocked item", () => {
    write("user", {
      languages: {
        typescript: {
          items: [
            {
              id: "no-any",
              kind: "rule",
              text: "no any (user, locked)",
              origin: "manual",
              locked: true,
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [
            {
              id: "no-any",
              kind: "rule",
              text: "no any (workspace)",
              origin: "manual",
            },
          ],
        },
      },
    });
    const r = resolve();
    const item = r.config.languages?.typescript?.items?.find(
      (i) => i.id === "no-any",
    );
    expect(item?.text).toBe("no any (user, locked)");
    expect(r.provenance["languages.typescript.items.no-any"]).toEqual({
      scope: "user",
      locked: true,
      reason: "locked",
    });
  });

  it("collision: an enforced item beats a more specific non-enforced item", () => {
    write("user", {
      languages: {
        typescript: {
          items: [
            {
              id: "strict-null",
              kind: "rule",
              text: "strict (user, enforced)",
              origin: "manual",
              enforced: true,
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [
            {
              id: "strict-null",
              kind: "rule",
              text: "strict (workspace)",
              origin: "manual",
            },
          ],
        },
      },
    });
    const r = resolve();
    const item = r.config.languages?.typescript?.items?.find(
      (i) => i.id === "strict-null",
    );
    expect(item?.text).toBe("strict (user, enforced)");
    expect(r.provenance["languages.typescript.items.strict-null"]).toEqual({
      scope: "user",
      locked: true,
      reason: "enforced",
    });
  });

  it("collision: managed.json wins even without an explicit locked/enforced flag on its own item", () => {
    write("org", {
      languages: {
        typescript: {
          items: [
            {
              id: "no-any",
              kind: "rule",
              text: "no any (org)",
              origin: "manual",
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [
            {
              id: "no-any",
              kind: "rule",
              text: "no any (workspace)",
              origin: "manual",
              enforced: true,
            },
          ],
        },
      },
    });
    const r = resolve();
    const item = r.config.languages?.typescript?.items?.find(
      (i) => i.id === "no-any",
    );
    expect(item?.text).toBe("no any (org)");
    expect(r.provenance["languages.typescript.items.no-any"]).toEqual({
      scope: "org",
      locked: true,
      reason: "managed",
    });
  });

  it("merges voice most-specifically per language, independent of items", () => {
    write("user", { languages: { english: { voice: { tone: "casual" } } } });
    write("workspace", {
      languages: {
        english: { voice: { tone: "confident, concise, technical" } },
      },
    });
    expect(resolve().config.languages?.english?.voice?.tone).toBe(
      "confident, concise, technical",
    );
  });
});

describe("resolveWorkspaceConfig — sources.* accumulate", () => {
  it("unions sources.workspace.<category> string lists by value across scopes", () => {
    write("workspace", {
      sources: { workspace: { skills: [".agents/skills"] } },
    });
    write("user", { sources: { workspace: { skills: [".claude/skills"] } } });
    const skills = resolve().config.sources?.workspace?.skills;
    expect([...(skills ?? [])].sort()).toEqual([
      ".agents/skills",
      ".claude/skills",
    ]);
  });

  it("does not duplicate a value contributed by multiple scopes", () => {
    write("org", { sources: { scan: ["workspace"] } });
    write("user", { sources: { scan: ["workspace", "user"] } });
    expect(resolve().config.sources?.scan?.sort()).toEqual([
      "user",
      "workspace",
    ]);
  });
});

describe("explain", () => {
  it("reports the winning scope and a managed-lock reason", () => {
    write("org", { packageManagers: { primary: "pnpm" } });
    write("workspace", { packageManagers: { primary: "npm" } });
    expect(explain(cwd, "packageManagers.primary", opts())).toEqual({
      path: "packageManagers.primary",
      scope: "org",
      locked: true,
      reason: "locked by managed.json (org)",
    });
  });

  it("reports a most-specific reason when nothing is locked", () => {
    write("user", { packageManagers: { primary: "yarn" } });
    write("workspace", { packageManagers: { primary: "pnpm" } });
    expect(explain(cwd, "packageManagers.primary", opts())).toEqual({
      path: "packageManagers.primary",
      scope: "workspace",
      locked: false,
      reason: "most specific: workspace.json (workspace)",
    });
  });

  it("reports not-set for a path nobody defines", () => {
    const result = explain(cwd, "nope.nothing", opts());
    expect(result.scope).toBeNull();
    expect(result.locked).toBe(false);
    expect(result.reason).toContain("not set");
  });

  it("reports a locked-by-user reason for a language item", () => {
    write("user", {
      languages: {
        typescript: {
          items: [
            {
              id: "no-any",
              kind: "rule",
              text: "t",
              origin: "manual",
              locked: true,
            },
          ],
        },
      },
    });
    write("workspace", {
      languages: {
        typescript: {
          items: [{ id: "no-any", kind: "rule", text: "t2", origin: "manual" }],
        },
      },
    });
    expect(explain(cwd, "languages.typescript.items.no-any", opts())).toEqual({
      path: "languages.typescript.items.no-any",
      scope: "user",
      locked: true,
      reason: "locked by user.json (user)",
    });
  });
});

describe("resolveWorkspaceConfig — invalid files", () => {
  it("records a scope error but still merges the valid scopes", () => {
    write("workspace", { packageManagers: { primary: "pnpm" } });
    const paths = getConfigScopePaths(cwd, {
      managedConfigPath: managedPath,
      userConfigPath: userPath,
    });
    mkdirSync(join(paths.repo, ".."), { recursive: true });
    writeFileSync(
      paths.repo,
      JSON.stringify({ repos: [{ provider: "gitlab", fullName: "x/y" }] }),
      "utf8",
    );
    const r = resolve();
    expect(r.config.packageManagers?.primary).toBe("pnpm");
    expect(r.scopes.find((s) => s.scope === "repo")?.error).toBeTruthy();
  });

  it("records an error for malformed JSON", () => {
    const paths = getConfigScopePaths(cwd, {
      managedConfigPath: managedPath,
      userConfigPath: userPath,
    });
    mkdirSync(join(paths.workspace, ".."), { recursive: true });
    writeFileSync(paths.workspace, "{ not json", "utf8");
    const r = resolve();
    expect(r.scopes.find((s) => s.scope === "workspace")?.error).toContain(
      "invalid JSON",
    );
  });
});

describe("resolveWorkspaceConfig — cache", () => {
  it("caches by scope paths and clears on demand", () => {
    write("workspace", { packageManagers: { primary: "pnpm" } });
    const cacheOpts = {
      managedConfigPath: managedPath,
      userConfigPath: userPath,
    };
    const first = resolveWorkspaceConfig(cwd, cacheOpts);
    expect(first.config.packageManagers?.primary).toBe("pnpm");
    write("workspace", { packageManagers: { primary: "npm" } });
    expect(
      resolveWorkspaceConfig(cwd, cacheOpts).config.packageManagers?.primary,
    ).toBe("pnpm");
    clearWorkspaceConfigCache();
    expect(
      resolveWorkspaceConfig(cwd, cacheOpts).config.packageManagers?.primary,
    ).toBe("npm");
  });
});

describe("resolveWorkspaceConfig — back-compat with today's workspace.json", () => {
  it("resolves an identity-only workspace.json (WorkspaceLink shape, no config sections)", () => {
    write("workspace", {
      orgSlug: "acme",
      orgId: "org_abc123",
      orgName: "Acme Corp",
      workspaceSlug: "main",
      workspaceId: "ws_xyz789",
      workspaceName: "Main Workspace",
      linkedAt: "2026-01-01T00:00:00.000Z",
    });
    const r = resolve();
    expect(r.config.orgSlug).toBe("acme");
    expect(r.config.workspaceId).toBe("ws_xyz789");
    expect(
      r.scopes.find((s) => s.scope === "workspace")?.error,
    ).toBeUndefined();
  });
});

describe("mergeWorkspaceConfigs — in-memory (no fs)", () => {
  it("merges scope files passed directly, org winning an unlocked-elsewhere leaf", () => {
    const { config, provenance } = mergeWorkspaceConfigs([
      {
        scope: "org",
        path: "managed.json",
        config: { packageManagers: { primary: "pnpm" } },
      },
      { scope: "user", path: "user.json" },
      {
        scope: "workspace",
        path: "workspace.json",
        config: { packageManagers: { primary: "npm" } },
      },
      { scope: "repo", path: "repo.json" },
    ]);
    expect(config.packageManagers?.primary).toBe("pnpm");
    expect(provenance["packageManagers.primary"]?.scope).toBe("org");
  });
});
