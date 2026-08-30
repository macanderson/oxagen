import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeSettingsValue,
  writeStarterSettings,
  envVarForSettingsKey,
  shellShadowsSettingsKey,
} from "../write.js";
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
    const path = writeSettingsValue({
      scope: "project",
      key: "model",
      value: "a/b",
      cwd: dir,
    });
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(getScopePaths({ cwd: dir }).project);
    const reread = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    }).settings;
    expect(reread.model).toBe("a/b");
  });

  it("writes an env var via the env.NAME form", () => {
    writeSettingsValue({
      scope: "local",
      key: "env.MY_TOKEN",
      value: "sek",
      cwd: dir,
    });
    const reread = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    }).settings;
    expect(reread.env?.MY_TOKEN).toBe("sek");
  });

  it("merges into an existing file rather than clobbering it", () => {
    writeSettingsValue({
      scope: "project",
      key: "model",
      value: "a/b",
      cwd: dir,
    });
    writeSettingsValue({
      scope: "project",
      key: "env.K",
      value: "v",
      cwd: dir,
    });
    const reread = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    }).settings;
    expect(reread.model).toBe("a/b");
    expect(reread.env?.K).toBe("v");
  });

  it("rejects an unsupported key", () => {
    expect(() =>
      writeSettingsValue({
        scope: "project",
        key: "permissions",
        value: "x",
        cwd: dir,
      }),
    ).toThrow(/cannot set/);
  });

  it("rejects an empty env name", () => {
    expect(() =>
      writeSettingsValue({
        scope: "project",
        key: "env.",
        value: "x",
        cwd: dir,
      }),
    ).toThrow();
  });
});

describe("writeSettingsValue — confirmScope (boolean)", () => {
  it('writes a real JSON boolean, not the string "true"', () => {
    const path = writeSettingsValue({
      scope: "project",
      key: "confirmScope",
      value: "true",
      cwd: dir,
    });
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(doc["confirmScope"]).toBe(true);
    expect(typeof doc["confirmScope"]).toBe("boolean");
  });

  it("round-trips false through loadSettings", () => {
    writeSettingsValue({
      scope: "project",
      key: "confirmScope",
      value: "false",
      cwd: dir,
    });
    const reread = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    }).settings;
    expect(reread.confirmScope).toBe(false);
  });

  it("accepts case-insensitive / whitespace-padded boolean text", () => {
    writeSettingsValue({
      scope: "project",
      key: "confirmScope",
      value: "  TRUE  ",
      cwd: dir,
    });
    const reread = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    }).settings;
    expect(reread.confirmScope).toBe(true);
  });

  it("rejects a non-boolean value", () => {
    expect(() =>
      writeSettingsValue({
        scope: "project",
        key: "confirmScope",
        value: "yes",
        cwd: dir,
      }),
    ).toThrow(/invalid boolean value/);
  });
});

describe("writeStarterSettings", () => {
  it("creates a valid starter file and is idempotent", () => {
    const first = writeStarterSettings({ scope: "project", cwd: dir });
    expect(first.created).toBe(true);
    const doc = JSON.parse(readFileSync(first.path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(doc["$schema"]).toBeTruthy();
    expect(doc["permissions"]).toBeTruthy();

    const second = writeStarterSettings({ scope: "project", cwd: dir });
    expect(second.created).toBe(false);
  });

  it("starter file passes validation via loadSettings", () => {
    writeStarterSettings({ scope: "project", cwd: dir });
    const resolved = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    });
    expect(
      resolved.scopes.find((s) => s.scope === "project")?.error,
    ).toBeUndefined();
  });

  // Item 6a: the starter file used to plant DEFAULT_CODING_MODEL, which meant
  // a fresh `oxagen settings init` permanently masked `oxagen config model
  // <x>` (store #2) with no warning — applySettingsToEnv projects
  // settings.model into OXAGEN_MODEL whenever the shell hasn't set it, and
  // resolveModelId checks OXAGEN_MODEL before ever consulting store #2.
  it("does NOT seed a default model — store #2 / built-in default governs until the user opts in", () => {
    const { path } = writeStarterSettings({ scope: "project", cwd: dir });
    const doc = JSON.parse(readFileSync(path, "utf8")) as Record<
      string,
      unknown
    >;
    expect(doc["model"]).toBeUndefined();
    const resolved = loadSettings({
      cwd: dir,
      userSettingsPath: userPath,
      noCache: true,
    });
    expect(resolved.settings.model).toBeUndefined();
  });
});

describe("envVarForSettingsKey / shellShadowsSettingsKey (item 7a)", () => {
  const saved: Record<string, string | undefined> = {};
  const TOUCHED = ["OXAGEN_MODEL", "OXAGEN_API_URL", "OXAGEN_WT_TEST"];

  beforeEach(() => {
    for (const k of TOUCHED) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of TOUCHED) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("maps model/apiUrl/env.<NAME> to their projected env var names", () => {
    expect(envVarForSettingsKey("model")).toBe("OXAGEN_MODEL");
    expect(envVarForSettingsKey("apiUrl")).toBe("OXAGEN_API_URL");
    expect(envVarForSettingsKey("env.OXAGEN_WT_TEST")).toBe("OXAGEN_WT_TEST");
  });

  it("returns undefined for a key that isn't projected at all", () => {
    expect(envVarForSettingsKey("permissions")).toBeUndefined();
    expect(envVarForSettingsKey("env.")).toBeUndefined();
  });

  it("shellShadowsSettingsKey is false when the shell doesn't export the var", () => {
    expect(shellShadowsSettingsKey("model")).toBe(false);
  });

  it("shellShadowsSettingsKey is true when the shell already exports the projected var", () => {
    process.env["OXAGEN_MODEL"] = "vendor/shell";
    expect(shellShadowsSettingsKey("model")).toBe(true);
    process.env["OXAGEN_WT_TEST"] = "x";
    expect(shellShadowsSettingsKey("env.OXAGEN_WT_TEST")).toBe(true);
  });

  it("treats an empty-string env var as unset (not shadowed)", () => {
    process.env["OXAGEN_API_URL"] = "";
    expect(shellShadowsSettingsKey("apiUrl")).toBe(false);
  });
});

describe("atomic writes (item 9) — writeScopeDoc/writeStarterSettings never leave a partial file", () => {
  it("writeSettingsValue leaves no stray .tmp files behind after a successful write", () => {
    writeSettingsValue({
      scope: "project",
      key: "model",
      value: "a/b",
      cwd: dir,
    });
    const projectDir = join(dir, ".oxagen");
    const entries = readdirSync(projectDir);
    expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
    expect(entries).toContain("settings.json");
  });

  it("a write that fails schema validation never touches the target file (temp-write-then-rename semantics)", () => {
    // apiUrl must be a valid URL — an invalid one fails oxagenSettingsSchema.parse
    // before writeScopeDoc ever calls atomicWriteFileSync, so no rename happens.
    expect(() =>
      writeSettingsValue({
        scope: "project",
        key: "apiUrl",
        value: "not-a-url",
        cwd: dir,
      }),
    ).toThrow();
    const path = getScopePaths({ cwd: dir }).project;
    expect(existsSync(path)).toBe(false);
  });
});
