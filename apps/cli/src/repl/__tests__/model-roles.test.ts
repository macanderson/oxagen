/**
 * Unit tests for the eager pipeline-role model resolution shown in the TUI's
 * MODELS readout at launch. Mirrors the engine's own resolution (see
 * model-roles.ts's doc comment): worker is the pinned slug, judge follows
 * pickAdvisorModel/pickJudgePanel, planner follows OXAGEN_LLM_EVALUATOR.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_ADVISOR_MODEL } from "@oxagen/agent-engine";
import { resolveModelRoles, persistRoleModel } from "../model-roles.js";
import { clearSettingsCache } from "../../settings/resolve.js";

const ENV_KEYS = [
  "OXAGEN_LLM_EVALUATOR",
  "OXAGEN_LLM_ADVISOR",
  "OXAGEN_JUDGE_PANEL",
] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
  {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolveModelRoles", () => {
  it("resolves all three roles from defaults so the TUI shows them before any prompt", () => {
    // The worker must be a slug distinct from DEFAULT_ADVISOR_MODEL (the balanced
    // tier, currently Sonnet) so the judge resolves to the default advisor rather
    // than diverging. If the worker equals the default advisor, pickAdvisorModel
    // intentionally picks a different model so work is never graded by itself —
    // that divergence path is covered by the next test.
    const worker = "anthropic/claude-fable-5";
    const roles = resolveModelRoles(worker);
    expect(roles.worker).toBe(worker);
    expect(roles.judge).toBe(DEFAULT_ADVISOR_MODEL);
    expect(roles.planner).toBe("local");
  });

  it("never grades the worker with itself — judge diverges when the worker IS the default advisor", () => {
    const roles = resolveModelRoles(DEFAULT_ADVISOR_MODEL);
    expect(roles.judge).toBeDefined();
    expect(roles.judge).not.toBe(DEFAULT_ADVISOR_MODEL);
  });

  it("honors the OXAGEN_LLM_ADVISOR judge override, same as the pipeline", () => {
    process.env["OXAGEN_LLM_ADVISOR"] = "openai/gpt-5.5-pro";
    const roles = resolveModelRoles("anthropic/claude-sonnet-5");
    expect(roles.judge).toBe("openai/gpt-5.5-pro");
  });

  it("shows the cross-vendor panel when OXAGEN_JUDGE_PANEL is set", () => {
    process.env["OXAGEN_JUDGE_PANEL"] =
      "openai/gpt-5.5-pro,google/gemini-2.5-pro";
    const roles = resolveModelRoles("anthropic/claude-sonnet-5");
    expect(roles.judge).toBe("panel(gpt-5.5-pro,gemini-2.5-pro)");
  });

  it("honors the OXAGEN_LLM_EVALUATOR planner override", () => {
    process.env["OXAGEN_LLM_EVALUATOR"] = "anthropic/claude-haiku-4-5";
    const roles = resolveModelRoles("anthropic/claude-sonnet-5");
    expect(roles.planner).toBe("anthropic/claude-haiku-4-5");
  });

  it("explicit overrides win over env/heuristic (live /triage-model, /judge-model)", () => {
    process.env["OXAGEN_LLM_EVALUATOR"] = "env/triage";
    process.env["OXAGEN_LLM_ADVISOR"] = "env/judge";
    const roles = resolveModelRoles("anthropic/claude-sonnet-5", {
      triage: "override/triage",
      judge: "override/judge",
    });
    expect(roles.planner).toBe("override/triage");
    expect(roles.judge).toBe("override/judge");
  });
});

describe("persistRoleModel", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oxagen-roles-"));
    clearSettingsCache();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    clearSettingsCache();
  });

  const localDoc = () =>
    JSON.parse(
      readFileSync(join(dir, ".oxagen", "settings.local.json"), "utf8"),
    ) as Record<string, unknown>;

  it("writes each role to its settings key in the local scope", () => {
    persistRoleModel("worker", "vendor/worker", dir);
    persistRoleModel("judge", "vendor/judge", dir);
    persistRoleModel("triage", "vendor/triage", dir);
    const doc = localDoc();
    expect(doc["workerModel"]).toBe("vendor/worker");
    expect(doc["judgeModel"]).toBe("vendor/judge");
    expect(doc["triageModel"]).toBe("vendor/triage");
  });
});
