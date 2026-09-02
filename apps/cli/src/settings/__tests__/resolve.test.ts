import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadSettings,
  getScopePaths,
  clearSettingsCache,
  migrateUserSettings,
} from "../resolve.js";
import type { OxagenSettings } from "../schema.js";

let dir: string;
let userPath: string;

function write(
  scope: "user" | "project" | "local",
  body: OxagenSettings,
): void {
  const paths = getScopePaths({ cwd: dir, userSettingsPath: userPath });
  mkdirSync(join(paths[scope], ".."), { recursive: true });
  writeFileSync(paths[scope], JSON.stringify(body), "utf8");
}

function resolve(): OxagenSettings {
  return loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true })
    .settings;
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

  it("resolves confirmScope as a plain scalar — local overrides project overrides user", () => {
    write("user", { confirmScope: false });
    write("project", { confirmScope: false });
    write("local", { confirmScope: true });
    expect(resolve().confirmScope).toBe(true);
  });

  it("confirmScope is absent (not false) when no scope sets it", () => {
    write("project", { model: "p/model" });
    expect(resolve().confirmScope).toBeUndefined();
  });

  it("merges env keys across scopes, higher scope winning per key", () => {
    write("user", { env: { A: "1", B: "1" } });
    write("project", { env: { B: "2", C: "2" } });
    expect(resolve().env).toEqual({ A: "1", B: "2", C: "2" });
  });

  it("concatenates and dedupes permission allow/deny; higher scope's mode wins", () => {
    write("user", {
      permissions: {
        defaultMode: "default",
        deny: ["Bash(rm*)"],
        allow: ["Read"],
      },
    });
    write("project", {
      permissions: { defaultMode: "deny", deny: ["Bash(rm*)", "Write(.env*)"] },
    });
    const p = resolve().permissions!;
    expect(p.defaultMode).toBe("deny");
    expect(p.deny).toEqual(["Bash(rm*)", "Write(.env*)"]); // deduped
    expect(p.allow).toEqual(["Read"]);
  });

  it("concatenates hooks per event across scopes", () => {
    write("user", {
      hooks: {
        PreToolUse: [
          { matcher: "bash", hooks: [{ type: "command", command: "a" }] },
        ],
      },
    });
    write("local", {
      hooks: {
        PreToolUse: [
          { matcher: "write_file", hooks: [{ type: "command", command: "b" }] },
        ],
      },
    });
    const pre = resolve().hooks?.PreToolUse;
    expect(pre).toHaveLength(2);
    expect(pre?.[0]?.matcher).toBe("bash");
    expect(pre?.[1]?.matcher).toBe("write_file");
  });

  it("merges mcpServers by key", () => {
    write("user", {
      mcpServers: { a: { transport: "stdio", command: "x", args: [] } },
    });
    write("project", {
      mcpServers: { b: { transport: "stdio", command: "y", args: [] } },
    });
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
    const resolved = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    });
    expect(resolved.settings.model).toBe("good/model");
    const local = resolved.scopes.find((s) => s.scope === "local");
    expect(local?.error).toBeTruthy();
  });

  it("records an error for malformed JSON", () => {
    const paths = getScopePaths({ cwd: dir, userSettingsPath: userPath });
    mkdirSync(join(paths.project, ".."), { recursive: true });
    writeFileSync(paths.project, "{ not json", "utf8");
    const resolved = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    });
    expect(resolved.scopes.find((s) => s.scope === "project")?.error).toContain(
      "invalid JSON",
    );
  });
});

describe("cache", () => {
  it("caches by scope paths and clears on demand", () => {
    write("project", { model: "v1/model" });
    const first = loadSettings({ cwd: dir, userSettingsPath: userPath });
    expect(first.settings.model).toBe("v1/model");
    // overwrite on disk; cached read still returns the old value
    write("project", { model: "v2/model" });
    expect(
      loadSettings({ cwd: dir, userSettingsPath: userPath }).settings.model,
    ).toBe("v1/model");
    clearSettingsCache();
    expect(
      loadSettings({ cwd: dir, userSettingsPath: userPath }).settings.model,
    ).toBe("v2/model");
  });
});

// ---------------------------------------------------------------------------
// Migration / legacy-path fallback (Claude-Code parity path change)
// ---------------------------------------------------------------------------

describe("migrateUserSettings", () => {
  let migrationDir: string;

  beforeEach(() => {
    migrationDir = mkdtempSync(join(tmpdir(), "oxagen-migrate-"));
  });

  afterEach(() => {
    rmSync(migrationDir, { recursive: true, force: true });
  });

  it("copies the legacy file to the canonical path when canonical is absent", () => {
    const legacy = join(migrationDir, "legacy", "settings.json");
    const canonical = join(migrationDir, "canonical", "settings.json");

    mkdirSync(join(migrationDir, "legacy"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ model: "migrated/model" }), "utf8");

    const migrated = migrateUserSettings(canonical, legacy);
    expect(migrated).toBe(true);
    expect(existsSync(canonical)).toBe(true);
    expect(JSON.parse(readFileSync(canonical, "utf8"))).toMatchObject({
      model: "migrated/model",
    });
  });

  it("does not overwrite a canonical file that already exists", () => {
    const legacy = join(migrationDir, "legacy", "settings.json");
    const canonical = join(migrationDir, "canonical", "settings.json");

    mkdirSync(join(migrationDir, "legacy"), { recursive: true });
    mkdirSync(join(migrationDir, "canonical"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({ model: "legacy/model" }), "utf8");
    writeFileSync(
      canonical,
      JSON.stringify({ model: "canonical/model" }),
      "utf8",
    );

    const migrated = migrateUserSettings(canonical, legacy);
    expect(migrated).toBe(false);
    // Canonical content must be untouched
    expect(JSON.parse(readFileSync(canonical, "utf8"))).toMatchObject({
      model: "canonical/model",
    });
  });

  it("returns false and does nothing when neither file exists", () => {
    const legacy = join(migrationDir, "no-such-dir", "settings.json");
    const canonical = join(migrationDir, "no-such-dir2", "settings.json");
    const result = migrateUserSettings(canonical, legacy);
    expect(result).toBe(false);
    expect(existsSync(canonical)).toBe(false);
  });

  it("creates parent directories for the canonical path when they are absent", () => {
    const legacy = join(migrationDir, "legacy.json");
    const canonical = join(
      migrationDir,
      "deep",
      "nested",
      "dir",
      "settings.json",
    );

    writeFileSync(legacy, JSON.stringify({ model: "deep/model" }), "utf8");

    const migrated = migrateUserSettings(canonical, legacy);
    expect(migrated).toBe(true);
    expect(existsSync(canonical)).toBe(true);
  });
});
