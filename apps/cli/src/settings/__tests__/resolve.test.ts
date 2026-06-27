import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings, getScopePaths, clearSettingsCache } from "../resolve.js";
import type { OxagenSettings } from "../schema.js";

let dir: string;
let userPath: string;

function write(scope: "user" | "project" | "local", body: OxagenSettings): void {
  const paths = getScopePaths({ cwd: dir, userSettingsPath: userPath });
  mkdirSync(join(paths[scope], ".."), { recursive: true });
  writeFileSync(paths[scope], JSON.stringify(body), "utf8");
}

function resolve(): OxagenSettings {
  return loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true }).settings;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-settings-"));
  userPath = join(dir, "user-settings.json");
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSettingsCache();
});

describe("loadSettings precedence", () => {
  it("returns empty settings when no files exist", () => {
    expect(resolve()).toEqual({});
  });

  it("local overrides project overrides user for scalars", () => {
    write("user", { model: "u/model", apiUrl: "https://u.example.com" });
    write("project", { model: "p/model" });
    write("local", { model: "l/model" });
    const s = resolve();
    expect(s.model).toBe("l/model");
    // apiUrl only set at user scope — survives the merge
    expect(s.apiUrl).toBe("https://u.example.com");
  });

  it("merges env keys across scopes, higher scope winning per key", () => {
    write("user", { env: { A: "1", B: "1" } });
    write("project", { env: { B: "2", C: "2" } });
    expect(resolve().env).toEqual({ A: "1", B: "2", C: "2" });
  });

  it("concatenates and dedupes permission allow/deny; higher scope's mode wins", () => {
    write("user", { permissions: { defaultMode: "default", deny: ["Bash(rm*)"], allow: ["Read"] } });
    write("project", {
      permissions: { defaultMode: "deny", deny: ["Bash(rm*)", "Write(.env*)"] },
    });
    const p = resolve().permissions!;
    expect(p.defaultMode).toBe("deny");
    expect(p.deny).toEqual(["Bash(rm*)", "Write(.env*)"]); // deduped
    expect(p.allow).toEqual(["Read"]);
  });

  it("concatenates hooks per event across scopes", () => {
    write("user", { hooks: { PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "a" }] }] } });
    write("local", { hooks: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "b" }] }] } });
    const pre = resolve().hooks?.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre?.[0]?.matcher).toBe("bash");
    expect(pre?.[1]?.matcher).toBe("write_file");
  });

  it("merges mcpServers by key", () => {
    write("user", { mcpServers: { a: { transport: "stdio", command: "x", args: [] } } });
    write("project", { mcpServers: { b: { transport: "stdio", command: "y", args: [] } } });
    expect(Object.keys(resolve().mcpServers ?? {})).toEqual(["a", "b"]);
  });
});

describe("env var expansion", () => {
  const KEY = "OXAGEN_TEST_EXPAND_VAL";
  afterEach(() => {
    delete process.env[KEY];
  });
  it("expands ${VAR} in string values", () => {
    process.env[KEY] = "expanded";
    write("project", { env: { TOKEN: `pre-\${${KEY}}-post` } });
    expect(resolve().env?.TOKEN).toBe("pre-expanded-post");
  });
});

describe("invalid files", () => {
  it("records a scope error but still merges the valid scopes", () => {
    write("project", { model: "good/model" });
    // hand-write an invalid local file (bad apiUrl)
    const paths = getScopePaths({ cwd: dir, userSettingsPath: userPath });
    writeFileSync(paths.local, JSON.stringify({ apiUrl: "nope" }), "utf8");
    const resolved = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true });
    expect(resolved.settings.model).toBe("good/model");
    const local = resolved.scopes.find((s) => s.scope === "local");
    expect(local?.error).toBeTruthy();
  });

  it("records an error for malformed JSON", () => {
    const paths = getScopePaths({ cwd: dir, userSettingsPath: userPath });
    mkdirSync(join(paths.project, ".."), { recursive: true });
    writeFileSync(paths.project, "{ not json", "utf8");
    const resolved = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true });
    expect(resolved.scopes.find((s) => s.scope === "project")?.error).toContain("invalid JSON");
  });
});

describe("cache", () => {
  it("caches by scope paths and clears on demand", () => {
    write("project", { model: "v1/model" });
    const first = loadSettings({ cwd: dir, userSettingsPath: userPath });
    expect(first.settings.model).toBe("v1/model");
    // overwrite on disk; cached read still returns the old value
    write("project", { model: "v2/model" });
    expect(loadSettings({ cwd: dir, userSettingsPath: userPath }).settings.model).toBe("v1/model");
    clearSettingsCache();
    expect(loadSettings({ cwd: dir, userSettingsPath: userPath }).settings.model).toBe("v2/model");
  });
});
