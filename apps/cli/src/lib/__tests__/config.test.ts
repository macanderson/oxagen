/**
 * `lib/config.ts` — the credential store at `~/.config/oxagen/config.json`.
 *
 * `node:os`'s homedir is redirected at a temp directory so every read and write
 * below hits a throwaway file, never the developer's real config. Each getter
 * follows the same precedence: environment variable first, persisted config
 * second, built-in default last.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let home: string;

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => home };
});

const ENV_KEYS = [
  "OXAGEN_API_TOKEN",
  "OXAGEN_ORG_ID",
  "OXAGEN_WORKSPACE_ID",
  "OXAGEN_API_URL",
  "OXAGEN_APP_URL",
] as const;

let saved: Record<string, string | undefined>;
let stderr: typeof process.stderr.write;
let errOut = "";

async function config(): Promise<typeof import("../config.js")> {
  vi.resetModules();
  return import("../config.js");
}

function configFile(): string {
  return join(home, ".config", "oxagen", "config.json");
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "oxagen-config-test-"));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  errOut = "";
  stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => {
    errOut += s;
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stderr.write = stderr;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("readConfig", () => {
  it("returns an empty config when the file does not exist", async () => {
    const { readConfig } = await config();
    expect(readConfig()).toEqual({});
    expect(errOut).toBe("");
  });

  it("warns and returns empty when the file is corrupt", async () => {
    const { writeConfig, readConfig } = await config();
    writeConfig({ token: "t" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(configFile(), "{ not json");
    expect(readConfig()).toEqual({});
    expect(errOut).toContain("failed to read config file");
    expect(errOut).toContain("oxagen login");
  });
});

describe("writeConfig", () => {
  it("creates the config directory and writes pretty JSON", async () => {
    const { writeConfig } = await config();
    writeConfig({ token: "oxk_live_x", orgSlug: "acme" });
    expect(existsSync(configFile())).toBe(true);
    const raw = readFileSync(configFile(), "utf8");
    expect(raw).toContain("\n  ");
    expect(JSON.parse(raw)).toEqual({ token: "oxk_live_x", orgSlug: "acme" });
  });

  it("merges into the existing config rather than replacing it", async () => {
    const { writeConfig, readConfig } = await config();
    writeConfig({ token: "t1", orgSlug: "acme" });
    writeConfig({ workspaceSlug: "prod" });
    expect(readConfig()).toEqual({
      token: "t1",
      orgSlug: "acme",
      workspaceSlug: "prod",
    });
  });

  it("round-trips the telemetry section", async () => {
    const { writeConfig, readConfig } = await config();
    writeConfig({ telemetry: { enabled: false, installId: "id-1" } });
    expect(readConfig().telemetry).toEqual({
      enabled: false,
      installId: "id-1",
    });
  });
});

describe("clearConfig", () => {
  it("drops the session but leaves unrelated settings intact", async () => {
    const { writeConfig, clearConfig, readConfig } = await config();
    writeConfig({
      token: "t1",
      orgSlug: "acme",
      workspaceSlug: "prod",
      apiUrl: "https://api.example.test",
      telemetry: { enabled: false },
    });
    clearConfig();
    const after = readConfig();
    expect(after.token).toBeUndefined();
    expect(after.orgSlug).toBeUndefined();
    expect(after.workspaceSlug).toBeUndefined();
    expect(after.apiUrl).toBe("https://api.example.test");
    expect(after.telemetry).toEqual({ enabled: false });
  });
});

describe("getters", () => {
  it("read from the persisted config", async () => {
    const c = await config();
    c.writeConfig({
      token: "oxk_live_x",
      orgSlug: "acme",
      workspaceSlug: "prod",
      apiUrl: "https://api.example.test",
      appUrl: "https://app.example.test",
    });
    expect(c.getToken()).toBe("oxk_live_x");
    expect(c.getOrgId()).toBe("acme");
    expect(c.getWorkspaceId()).toBe("prod");
    expect(c.getApiUrl()).toBe("https://api.example.test");
    expect(c.getAppUrl()).toBe("https://app.example.test");
  });

  it("let the environment win over the persisted config", async () => {
    const c = await config();
    c.writeConfig({
      token: "from-file",
      orgSlug: "file-org",
      workspaceSlug: "file-ws",
      apiUrl: "https://file.test",
      appUrl: "https://file-app.test",
    });
    process.env["OXAGEN_API_TOKEN"] = "from-env";
    process.env["OXAGEN_ORG_ID"] = "env-org";
    process.env["OXAGEN_WORKSPACE_ID"] = "env-ws";
    process.env["OXAGEN_API_URL"] = "https://env.test";
    process.env["OXAGEN_APP_URL"] = "https://env-app.test";
    expect(c.getToken()).toBe("from-env");
    expect(c.getOrgId()).toBe("env-org");
    expect(c.getWorkspaceId()).toBe("env-ws");
    expect(c.getApiUrl()).toBe("https://env.test");
    expect(c.getAppUrl()).toBe("https://env-app.test");
  });

  it("fall back to the production URLs and undefined credentials", async () => {
    const c = await config();
    expect(c.getToken()).toBeUndefined();
    expect(c.getOrgId()).toBeUndefined();
    expect(c.getWorkspaceId()).toBeUndefined();
    expect(c.getApiUrl()).toBe("https://api.oxagen.sh");
    expect(c.getAppUrl()).toBe("https://app.oxagen.sh");
  });
});
