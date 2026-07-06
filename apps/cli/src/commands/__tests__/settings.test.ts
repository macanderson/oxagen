import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
import { captureWriter } from "../../lib/capture-writer.js";

let dir: string;
let ctx: SettingsCtx;
// Every command handler under test now takes an optional trailing
// `CommandWriter` (see lib/capture-writer.ts — the REPL inline
// capture-execution seam, PR C item 11) instead of writing straight to
// `console.log`/`console.error`. Tests capture via that writer directly
// rather than spying on console — it's the real seam every call site now
// goes through (default `stdoutWriter`, or this capture accumulator).
let writer: ReturnType<typeof captureWriter>["writer"];
let text: () => string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-cmd-settings-"));
  ctx = { cwd: dir, userSettingsPath: join(dir, "user-settings.json") };
  const cap = captureWriter();
  writer = cap.writer;
  text = cap.output;
  process.exitCode = undefined;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

/** Start a fresh capture for the next call within a multi-step test. */
function resetCapture(): void {
  const cap = captureWriter();
  writer = cap.writer;
  text = cap.output;
}

describe("settings command handlers", () => {
  it("init writes a starter file, then set + get round-trip", () => {
    settingsInit("project", ctx, writer);
    expect(text()).toContain("Wrote starter settings");

    resetCapture();
    settingsSet("model", "vendor/m", "project", ctx, writer);
    expect(text()).toContain("✓ model = vendor/m");

    resetCapture();
    settingsGet("model", ctx, writer);
    expect(text()).toBe("model: vendor/m");
  });

  it("init is idempotent", () => {
    settingsInit("project", ctx, writer);
    resetCapture();
    settingsInit("project", ctx, writer);
    expect(text()).toContain("already exists");
  });

  it("show reports the merged settings and scope sources", () => {
    settingsSet("apiUrl", "https://api.example.com", "project", ctx, writer);
    resetCapture();
    settingsShow(ctx, writer);
    expect(text()).toContain("https://api.example.com");
    expect(text()).toContain("project");
  });

  it("get prints (not set) for an absent key", () => {
    settingsGet("permissions.defaultMode", ctx, writer);
    expect(text()).toBe("permissions.defaultMode: (not set)");
  });

  it("path lists all three scopes with status", () => {
    settingsPath(ctx, writer);
    expect(text()).toContain("user");
    expect(text()).toContain("project");
    expect(text()).toContain("local");
  });

  it("validate flags a malformed scope file and sets a non-zero exit code", () => {
    const projectPath = getScopePaths(ctx).project;
    mkdirSync(join(projectPath, ".."), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ apiUrl: "not-a-url" }), "utf8");
    settingsValidate(ctx, writer);
    expect(text()).toContain("project");
    expect(process.exitCode).toBe(1);
  });

  it("set rejects an unknown scope", () => {
    settingsSet("model", "x", "bogus", ctx, writer);
    expect(text()).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });

  it("set surfaces an unsupported key as an error", () => {
    settingsSet("permissions", "x", "project", ctx, writer);
    expect(text()).toContain("cannot set");
    expect(process.exitCode).toBe(1);
  });

  it("init rejects an unknown scope", () => {
    settingsInit("bogus", ctx, writer);
    expect(text()).toContain("Unknown scope");
    expect(process.exitCode).toBe(1);
  });

  // Item 7a: settings.set used to print a confident "✓" even when the shell
  // already exported the same env var the key projects to — meaning
  // applySettingsToEnv's `isUnset` gate (runtime.ts) would silently ignore
  // the write for the rest of the session.
  describe("shell-shadow warning at set time", () => {
    const savedModel = process.env["OXAGEN_MODEL"];
    const savedCustom = process.env["OXAGEN_CFG_TEST_SHADOW"];
    afterEach(() => {
      if (savedModel === undefined) delete process.env["OXAGEN_MODEL"];
      else process.env["OXAGEN_MODEL"] = savedModel;
      if (savedCustom === undefined) delete process.env["OXAGEN_CFG_TEST_SHADOW"];
      else process.env["OXAGEN_CFG_TEST_SHADOW"] = savedCustom;
    });

    it("warns when setting `model` while the shell already exports OXAGEN_MODEL", () => {
      process.env["OXAGEN_MODEL"] = "vendor/shell";
      settingsSet("model", "vendor/settings", "project", ctx, writer);
      expect(text()).toContain("shell value wins until you unset OXAGEN_MODEL");
    });

    it("warns when setting env.<NAME> while the shell already exports that name", () => {
      process.env["OXAGEN_CFG_TEST_SHADOW"] = "already-here";
      settingsSet("env.OXAGEN_CFG_TEST_SHADOW", "new-value", "project", ctx, writer);
      expect(text()).toContain("shell value wins until you unset OXAGEN_CFG_TEST_SHADOW");
    });

    it("does not warn when the shell has no matching export", () => {
      delete process.env["OXAGEN_MODEL"];
      settingsSet("model", "vendor/settings", "project", ctx, writer);
      expect(text()).not.toContain("shell value wins");
    });
  });
});
