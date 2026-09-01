/**
 * Unit coverage for the reasoning-effort resolver:
 *   - resolveEffort / isReasoningEffort / EFFORT_LEVELS (agent/model.ts)
 *   - findModelMask (agent/model.ts) — item 6 of the config-truth audit
 *     (fix/cli-config-truth): detects whether OXAGEN_MODEL (shell, or
 *     projected from settings.json) would mask a value `oxagen config model`
 *     is about to write to store #2.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isReasoningEffort,
  resolveEffort,
  EFFORT_LEVELS,
  findModelMask,
} from "../model.js";

describe("reasoning effort", () => {
  afterEach(() => {
    delete process.env["OXAGEN_EFFORT"];
  });

  it("EFFORT_LEVELS includes the deep Anthropic tiers", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("isReasoningEffort accepts every level and rejects others", () => {
    for (const level of EFFORT_LEVELS)
      expect(isReasoningEffort(level)).toBe(true);
    expect(isReasoningEffort("ultra")).toBe(false);
    expect(isReasoningEffort("")).toBe(false);
    expect(isReasoningEffort("HIGH")).toBe(false);
  });

  it("resolveEffort honors an explicit override, including xhigh/max", () => {
    expect(resolveEffort("high")).toBe("high");
    expect(resolveEffort("xhigh")).toBe("xhigh");
    expect(resolveEffort("max")).toBe("max");
  });

  it("resolveEffort ignores an invalid override and falls through", () => {
    expect(resolveEffort("bogus")).toBeUndefined();
  });

  it("resolveEffort reads OXAGEN_EFFORT when no override is given", () => {
    process.env["OXAGEN_EFFORT"] = "xhigh";
    expect(resolveEffort()).toBe("xhigh");
    process.env["OXAGEN_EFFORT"] = "nonsense";
    expect(resolveEffort()).toBeUndefined();
  });
});

describe("findModelMask", () => {
  let cwd: string;
  let userSettingsPath: string;
  const savedModel = process.env["OXAGEN_MODEL"];

  function writeProjectSettings(body: Record<string, unknown>): void {
    const dir = join(cwd, ".oxagen");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "settings.json"), JSON.stringify(body), "utf8");
  }

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "oxagen-model-mask-"));
    userSettingsPath = join(cwd, "user-settings.json"); // deliberately absent — isolates from the real $HOME
    delete process.env["OXAGEN_MODEL"];
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (savedModel === undefined) delete process.env["OXAGEN_MODEL"];
    else process.env["OXAGEN_MODEL"] = savedModel;
  });

  it("returns null when OXAGEN_MODEL is unset", () => {
    expect(findModelMask("vendor/new", { cwd, userSettingsPath })).toBeNull();
  });

  it("returns null when OXAGEN_MODEL already matches the value being set", () => {
    process.env["OXAGEN_MODEL"] = "vendor/new";
    expect(findModelMask("vendor/new", { cwd, userSettingsPath })).toBeNull();
  });

  it("attributes the mask to the shell when OXAGEN_MODEL doesn't match any settings.json value", () => {
    process.env["OXAGEN_MODEL"] = "vendor/shell-only";
    const mask = findModelMask("vendor/new", { cwd, userSettingsPath });
    expect(mask?.value).toBe("vendor/shell-only");
    expect(mask?.source).toContain("shell");
  });

  it("attributes the mask to the settings.json scope that projected it", () => {
    writeProjectSettings({ model: "vendor/from-settings" });
    process.env["OXAGEN_MODEL"] = "vendor/from-settings"; // as applySettingsToEnv would have set it
    const mask = findModelMask("vendor/new", { cwd, userSettingsPath });
    expect(mask?.value).toBe("vendor/from-settings");
    expect(mask?.source).toContain("project settings.json");
  });
});
