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
import { captureWriter, type CommandWriter } from "../../lib/capture-writer.js";

/**
 * A CommandWriter that keeps stdout and stderr in SEPARATE buffers — the plain
 * captureWriter merges them, which is fine for "was this text emitted?" checks
 * but cannot prove the ADR-023 §4 discipline (result on stdout, errors/chrome
 * on stderr). Used by the output-discipline suite below.
 */
function splitWriter(): {
  writer: CommandWriter;
  out: () => string;
  err: () => string;
} {
  const o: string[] = [];
  const e: string[] = [];
  return {
    writer: {
      write: (l) => {
        o.push(l);
      },
      writeErr: (l) => {
        e.push(l);
      },
    },
    out: () => o.join("\n"),
    err: () => e.join("\n"),
  };
}

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

  it("set rejects an unknown scope with a usage exit code (2)", () => {
    settingsSet("model", "x", "bogus", ctx, writer);
    expect(text()).toContain("Unknown scope");
    // ADR-023 §4: a bad argument is a usage error → exit 2 (not a runtime 1).
    expect(process.exitCode).toBe(2);
  });

  it("set surfaces an unsupported key as an error", () => {
    settingsSet("permissions", "x", "project", ctx, writer);
    expect(text()).toContain("cannot set");
    expect(process.exitCode).toBe(1);
  });

  it("init rejects an unknown scope with a usage exit code (2)", () => {
    settingsInit("bogus", ctx, writer);
    expect(text()).toContain("Unknown scope");
    // ADR-023 §4: a bad argument is a usage error → exit 2 (not a runtime 1).
    expect(process.exitCode).toBe(2);
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
      if (savedCustom === undefined)
        delete process.env["OXAGEN_CFG_TEST_SHADOW"];
      else process.env["OXAGEN_CFG_TEST_SHADOW"] = savedCustom;
    });

    it("warns when setting `model` while the shell already exports OXAGEN_MODEL", () => {
      process.env["OXAGEN_MODEL"] = "vendor/shell";
      settingsSet("model", "vendor/settings", "project", ctx, writer);
      expect(text()).toContain("shell value wins until you unset OXAGEN_MODEL");
    });

    it("warns when setting env.<NAME> while the shell already exports that name", () => {
      process.env["OXAGEN_CFG_TEST_SHADOW"] = "already-here";
      settingsSet(
        "env.OXAGEN_CFG_TEST_SHADOW",
        "new-value",
        "project",
        ctx,
        writer,
      );
      expect(text()).toContain(
        "shell value wins until you unset OXAGEN_CFG_TEST_SHADOW",
      );
    });

    it("does not warn when the shell has no matching export", () => {
      delete process.env["OXAGEN_MODEL"];
      settingsSet("model", "vendor/settings", "project", ctx, writer);
      expect(text()).not.toContain("shell value wins");
    });
  });
});

// The ADR-023 §4 contract: `--json` (carried on `ctx.json`) emits ONE
// single-line JSON value on stdout and nothing else there; pretty mode keeps
// the human view on stdout; errors are uniform stderr lines with a usage (2) or
// runtime (1) exit code. `splitWriter` proves the stream split the merged
// captureWriter can't.
describe("settings output discipline (ADR-023 §4)", () => {
  it("get --json emits one single-line JSON value on stdout, nothing on stderr", () => {
    settingsSet("model", "vendor/m", "project", ctx, writer);
    const sp = splitWriter();
    settingsGet("model", { ...ctx, json: true }, sp.writer);
    const line = sp.out();
    expect(line).not.toContain("\n");
    expect(JSON.parse(line)).toEqual({
      key: "model",
      value: "vendor/m",
      present: true,
    });
    expect(sp.err()).toBe("");
  });

  it("get pretty keeps the exact human line on stdout", () => {
    settingsSet("model", "vendor/m", "project", ctx, writer);
    const sp = splitWriter();
    settingsGet("model", ctx, sp.writer);
    expect(sp.out()).toBe("model: vendor/m");
    expect(sp.err()).toBe("");
  });

  it("get --json returns value:null + present:false for an unset key", () => {
    const sp = splitWriter();
    settingsGet("permissions.defaultMode", { ...ctx, json: true }, sp.writer);
    expect(JSON.parse(sp.out())).toEqual({
      key: "permissions.defaultMode",
      value: null,
      present: false,
    });
  });

  it("show --json carries the merged settings + scope sources", () => {
    settingsSet("apiUrl", "https://api.example.com", "project", ctx, writer);
    const sp = splitWriter();
    settingsShow({ ...ctx, json: true }, sp.writer);
    const payload = JSON.parse(sp.out()) as {
      settings: { apiUrl?: string };
      scopes: { scope: string; ok: boolean }[];
    };
    expect(payload.settings.apiUrl).toBe("https://api.example.com");
    expect(payload.scopes.some((s) => s.scope === "project" && s.ok)).toBe(
      true,
    );
  });

  it("path --json lists every scope in precedence order with its existence flag", () => {
    const sp = splitWriter();
    settingsPath({ ...ctx, json: true }, sp.writer);
    const rows = JSON.parse(sp.out()) as {
      scope: string;
      path: string;
      exists: boolean;
    }[];
    expect(rows.map((r) => r.scope)).toEqual(["user", "project", "local"]);
    expect(rows.every((r) => typeof r.exists === "boolean")).toBe(true);
  });

  it("set --json round-trips the write result on stdout", () => {
    const sp = splitWriter();
    settingsSet(
      "apiUrl",
      "https://api.example.com",
      "project",
      { ...ctx, json: true },
      sp.writer,
    );
    const payload = JSON.parse(sp.out()) as {
      key: string;
      value: string;
      scope: string;
      path: string;
    };
    expect(payload).toMatchObject({
      key: "apiUrl",
      value: "https://api.example.com",
      scope: "project",
    });
    expect(payload.path.length).toBeGreaterThan(0);
  });

  it("init --json round-trips { path, created } and is single-line", () => {
    const sp = splitWriter();
    settingsInit("project", { ...ctx, json: true }, sp.writer);
    const line = sp.out();
    expect(line).not.toContain("\n");
    const payload = JSON.parse(line) as { path: string; created: boolean };
    expect(payload.created).toBe(true);
    expect(payload.path.length).toBeGreaterThan(0);
  });

  it("validate --json reports ok:false + a non-zero exit on a malformed file", () => {
    const projectPath = getScopePaths(ctx).project;
    mkdirSync(join(projectPath, ".."), { recursive: true });
    writeFileSync(projectPath, JSON.stringify({ apiUrl: "not-a-url" }), "utf8");
    const sp = splitWriter();
    settingsValidate({ ...ctx, json: true }, sp.writer);
    const payload = JSON.parse(sp.out()) as {
      ok: boolean;
      results: { scope: string; ok: boolean }[];
    };
    expect(payload.ok).toBe(false);
    expect(payload.results.some((r) => r.scope === "project" && !r.ok)).toBe(
      true,
    );
    expect(process.exitCode).toBe(1);
  });

  it("set with an unknown scope is a uniform stderr usage error (exit 2), nothing on stdout", () => {
    const sp = splitWriter();
    settingsSet("model", "x", "bogus", { ...ctx, json: true }, sp.writer);
    expect(sp.out()).toBe("");
    const err = JSON.parse(sp.err()) as {
      type: string;
      code: string;
      message: string;
    };
    expect(err).toMatchObject({ type: "error", code: "usage" });
    expect(err.message).toContain("Unknown scope");
    expect(process.exitCode).toBe(2);
  });

  it("set surfacing a write failure is a uniform stderr runtime error (exit 1)", () => {
    const sp = splitWriter();
    settingsSet(
      "permissions",
      "x",
      "project",
      { ...ctx, json: true },
      sp.writer,
    );
    expect(sp.out()).toBe("");
    const err = JSON.parse(sp.err()) as {
      type: string;
      code: string;
      message: string;
    };
    expect(err).toMatchObject({ type: "error", code: "error" });
    expect(err.message).toContain("cannot set");
    expect(process.exitCode).toBe(1);
  });
});
