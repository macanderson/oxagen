import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  settingsShow,
  settingsPath,
  settingsGet,
  settingsSet,
  settingsValidate,
  settingsInit,
  type SettingsCtx,
} from "../settings.js";
import { getScopePaths } from "../../settings/index.js";

let dir: string;
let ctx: SettingsCtx;
let out: string[];
let err: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-settings-"));
  ctx = { cwd: dir, userSettingsPath: join(dir, "user-settings.json") };
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void err.push(a.join(" ")));
  process.exitCode = undefined;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const text = () => out.join("\n");

describe("settings command handlers", () => {
  it("init writes a starter file, then set + get round-trip", () => {
    settingsInit("project", ctx);
    expect(text()).toContain("Wrote starter settings");

    settingsSet("model", "vendor/m", "project", ctx);
    expect(text()).toContain("✓ model = vendor/m");

    out = [];
    settingsGet("model", ctx);
    expect(text()).toBe("model: vendor/m");
  });

  it("init is idempotent", () => {
    settingsInit("project", ctx);
    out = [];
    settingsInit("project", ctx);
    expect(text()).toContain("already exists");
  });

  it("show reports the merged settings and scope sources", () => {
    settingsSet("apiUrl", "https://api.example.com", "project", ctx);
    out = [];
    settingsShow(ctx);
    expect(text()).toContain("https://api.example.com");
    expect(text()).toContain("project");
  });

  it("get prints (not set) for an absent key", () => {
    settingsGet("permissions.defaultMode", ctx);
    expect(text()).toBe("permissions.defaultMode: (not set)");
  });

  it("path lists all three scopes with status", () => {
    settingsPath(ctx);
    expect(text()).toContain("user");
    expect(text()).toContain("project");
    expect(text()).toContain("local");
  });

  it("validate flags a malformed scope file and sets a non-zero exit code", () => {
    const projectPath = getScopePaths(ctx).project;
    mkdirSync(join(projectPath, ".."), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ apiUrl: "not-a-url" }), "utf8");
    settingsValidate(ctx);
    expect(err.join("\n")).toContain("project");
    expect(process.exitCode).toBe(1);
  });

  it("set rejects an unknown scope", () => {
    settingsSet("model", "x", "bogus", ctx);
    expect(err.join("\n")).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });

  it("set surfaces an unsupported key as an error", () => {
    settingsSet("permissions", "x", "project", ctx);
    expect(err.join("\n")).toContain("cannot set");
    expect(process.exitCode).toBe(1);
  });

  it("init rejects an unknown scope", () => {
    settingsInit("bogus", ctx);
    expect(err.join("\n")).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });
});
