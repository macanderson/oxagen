import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettingsToEnv } from "../runtime.js";
import { getScopePaths, clearSettingsCache } from "../resolve.js";
import type { OxagenSettings } from "../schema.js";

let dir: string;
let userPath: string;
const TOUCHED = [
  "OXAGEN_MODEL",
  "OXAGEN_LLM_ADVISOR",
  "OXAGEN_LLM_EVALUATOR",
  "OXAGEN_API_URL",
  "OXAGEN_RT_TEST_A",
  "OXAGEN_RT_TEST_B",
];
const saved: Record<string, string | undefined> = {};

function writeProject(body: OxagenSettings): void {
  const path = getScopePaths({ cwd: dir, userSettingsPath: userPath }).project;
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(body), "utf8");
}

function apply() {
  return applySettingsToEnv({
    cwd: dir,
    userSettingsPath: userPath,
    noCache: true,
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "oxagen-runtime-"));
  userPath = join(dir, "user-settings.json");
  for (const k of TOUCHED) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  clearSettingsCache();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  clearSettingsCache();
});

describe("applySettingsToEnv", () => {
  it("fills unset env vars from settings.env", () => {
    writeProject({ env: { OXAGEN_RT_TEST_A: "from-settings" } });
    const applied = apply();
    expect(process.env["OXAGEN_RT_TEST_A"]).toBe("from-settings");
    expect(applied.envKeys).toContain("OXAGEN_RT_TEST_A");
  });

  it("does not override an env var the shell already set", () => {
    process.env["OXAGEN_RT_TEST_B"] = "from-shell";
    writeProject({ env: { OXAGEN_RT_TEST_B: "from-settings" } });
    const applied = apply();
    expect(process.env["OXAGEN_RT_TEST_B"]).toBe("from-shell");
    expect(applied.envKeys).not.toContain("OXAGEN_RT_TEST_B");
  });

  it("projects apiUrl and model into OXAGEN_API_URL / OXAGEN_MODEL when unset", () => {
    writeProject({ model: "vendor/model", apiUrl: "https://api.example.com" });
    const applied = apply();
    expect(process.env["OXAGEN_MODEL"]).toBe("vendor/model");
    expect(process.env["OXAGEN_API_URL"]).toBe("https://api.example.com");
    expect(applied.model).toBe(true);
    expect(applied.apiUrl).toBe(true);
  });

  it("leaves a shell-set OXAGEN_MODEL untouched", () => {
    process.env["OXAGEN_MODEL"] = "shell/model";
    writeProject({ model: "settings/model" });
    const applied = apply();
    expect(process.env["OXAGEN_MODEL"]).toBe("shell/model");
    expect(applied.model).toBe(false);
  });

  it("projects the per-role models into their engine env vars", () => {
    writeProject({
      judgeModel: "vendor/judge",
      triageModel: "vendor/triage",
    });
    const applied = apply();
    expect(process.env["OXAGEN_LLM_ADVISOR"]).toBe("vendor/judge");
    expect(process.env["OXAGEN_LLM_EVALUATOR"]).toBe("vendor/triage");
    expect(applied.judgeModel).toBe(true);
    expect(applied.triageModel).toBe(true);
  });

  it("workerModel wins over the generic model for OXAGEN_MODEL", () => {
    writeProject({ model: "vendor/base", workerModel: "vendor/worker" });
    apply();
    expect(process.env["OXAGEN_MODEL"]).toBe("vendor/worker");
  });

  it("falls back to model for the worker when workerModel is unset", () => {
    writeProject({ model: "vendor/base" });
    apply();
    expect(process.env["OXAGEN_MODEL"]).toBe("vendor/base");
  });

  it("leaves shell-set role env vars untouched", () => {
    process.env["OXAGEN_LLM_ADVISOR"] = "shell/judge";
    writeProject({ judgeModel: "settings/judge" });
    const applied = apply();
    expect(process.env["OXAGEN_LLM_ADVISOR"]).toBe("shell/judge");
    expect(applied.judgeModel).toBe(false);
  });

  it("is a no-op when there are no settings", () => {
    const applied = apply();
    expect(applied).toEqual({
      envKeys: [],
      apiUrl: false,
      model: false,
      judgeModel: false,
      triageModel: false,
    });
  });
});
