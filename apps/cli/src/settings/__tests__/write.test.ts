import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSettingsValue, writeStarterSettings } from "../write.js";
import { loadSettings, getScopePaths, clearSettingsCache } from "../resolve.js";

let dir: string;
let userPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-write-"));
  userPath = join(dir, "user-settings.json");
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearSettingsCache();
});

describe("writeSettingsValue", () => {
  it("writes a scalar into the project scope and round-trips through loadSettings", () => {
    const path = writeSettingsValue({ scope: "project", key: "model", value: "a/b", cwd: dir });
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(getScopePaths({ cwd: dir }).project);
    const reread = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true }).settings;
    expect(reread.model).toBe("a/b");
  });

  it("writes an env var via the env.NAME form", () => {
    writeSettingsValue({ scope: "local", key: "env.MY_TOKEN", value: "sek", cwd: dir });
    const reread = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true }).settings;
    expect(reread.env?.MY_TOKEN).toBe("sek");
  });

  it("merges into an existing file rather than clobbering it", () => {
    writeSettingsValue({ scope: "project", key: "model", value: "a/b", cwd: dir });
    writeSettingsValue({ scope: "project", key: "env.K", value: "v", cwd: dir });
    const reread = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true }).settings;
    expect(reread.model).toBe("a/b");
    expect(reread.env?.K).toBe("v");
  });

  it("rejects an unsupported key", () => {
    expect(() => writeSettingsValue({ scope: "project", key: "permissions", value: "x", cwd: dir })).toThrow(
      /cannot set/,
    );
  });

  it("rejects an empty env name", () => {
    expect(() => writeSettingsValue({ scope: "project", key: "env.", value: "x", cwd: dir })).toThrow();
  });
});

describe("writeStarterSettings", () => {
  it("creates a valid starter file and is idempotent", () => {
    const first = writeStarterSettings({ scope: "project", cwd: dir });
    expect(first.created).toBe(true);
    const doc = JSON.parse(readFileSync(first.path, "utf8")) as Record<string, unknown>;
    expect(doc["$schema"]).toBeTruthy();
    expect(doc["permissions"]).toBeTruthy();

    const second = writeStarterSettings({ scope: "project", cwd: dir });
    expect(second.created).toBe(false);
  });

  it("starter file passes validation via loadSettings", () => {
    writeStarterSettings({ scope: "project", cwd: dir });
    const resolved = loadSettings({ cwd: dir, userSettingsPath: userPath, noCache: true });
    expect(resolved.scopes.find((s) => s.scope === "project")?.error).toBeUndefined();
  });
});
