/**
 * solve.test.ts — pins `handleSolve`'s wiring (the pure resolveFullPipeline /
 * resolveVerifyAuto precedence is already covered in __tests__/solve.test.ts):
 * which AI port a synthetic vs platform session builds, the metered-AI fold
 * (metrics → the usage accumulator, logs → the timeout debug channel), the
 * --models/--model parsing, the 1..10 candidate clamp, what exactly reaches
 * launchBestOfN, and the non-zero exit when no candidate wins.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSession: vi.fn(),
  createGatewayAgentAi: vi.fn(),
  createPlatformAgentAi: vi.fn(),
  createMeteredAi: vi.fn(),
  createSolveUsageAccumulator: vi.fn(),
  loadProjectContext: vi.fn(),
  launchBestOfN: vi.fn(),
  debugLog: vi.fn(),
}));

vi.mock("../lib/session.js", () => ({ requireSession: mocks.requireSession }));
vi.mock("../agent/adapters/index.js", () => ({
  createGatewayAgentAi: mocks.createGatewayAgentAi,
  createPlatformAgentAi: mocks.createPlatformAgentAi,
}));
vi.mock("../agent/metered-ai.js", () => ({ createMeteredAi: mocks.createMeteredAi }));
vi.mock("../agent/solve-usage.js", () => ({
  createSolveUsageAccumulator: mocks.createSolveUsageAccumulator,
}));
vi.mock("../agent/project-context.js", () => ({
  loadProjectContext: mocks.loadProjectContext,
}));
vi.mock("../tui/best-of-n-view/index.js", () => ({
  launchBestOfN: mocks.launchBestOfN,
}));
vi.mock("../lib/debug-log.js", () => ({ debugLog: mocks.debugLog }));

import { handleSolve } from "./solve.js";

const gatewayAi = { kind: "gateway" };
const platformAi = { kind: "platform" };
const meteredAi = { kind: "metered" };
const projectContext = { name: "proj" };

let usage: { record: ReturnType<typeof vi.fn>; totals: { costUsd: number } };

const PIPELINE_ENV = "OXAGEN_BEST_OF_N_PIPELINE";
const VERIFY_ENV = "OXAGEN_BEST_OF_N_VERIFY";
let savedPipelineEnv: string | undefined;
let savedVerifyEnv: string | undefined;

/** The options object handleSolve handed launchBestOfN in this test. */
function launchArg(): Record<string, unknown> {
  expect(mocks.launchBestOfN).toHaveBeenCalledTimes(1);
  return mocks.launchBestOfN.mock.calls[0]?.[0] as Record<string, unknown>;
}

beforeEach(() => {
  savedPipelineEnv = process.env[PIPELINE_ENV];
  savedVerifyEnv = process.env[VERIFY_ENV];
  delete process.env[PIPELINE_ENV];
  delete process.env[VERIFY_ENV];
  process.exitCode = undefined;

  usage = { record: vi.fn(), totals: { costUsd: 0 } };
  mocks.requireSession.mockReturnValue({
    synthetic: true,
    apiUrl: "https://api.test",
    token: "tok_1",
    orgSlug: "acme",
    workspaceSlug: "main",
  });
  mocks.createGatewayAgentAi.mockReturnValue(gatewayAi);
  mocks.createPlatformAgentAi.mockReturnValue(platformAi);
  mocks.createMeteredAi.mockReturnValue(meteredAi);
  mocks.createSolveUsageAccumulator.mockReturnValue(usage);
  mocks.loadProjectContext.mockReturnValue(projectContext);
  mocks.launchBestOfN.mockResolvedValue({ selection: { winnerId: "cand_1" } });
});

afterEach(() => {
  if (savedPipelineEnv === undefined) delete process.env[PIPELINE_ENV];
  else process.env[PIPELINE_ENV] = savedPipelineEnv;
  if (savedVerifyEnv === undefined) delete process.env[VERIFY_ENV];
  else process.env[VERIFY_ENV] = savedVerifyEnv;
  process.exitCode = undefined;
});

describe("handleSolve — AI port selection", () => {
  it("a synthetic session races through the gateway AI, metered", async () => {
    await handleSolve("fix the test", {});
    expect(mocks.createGatewayAgentAi).toHaveBeenCalledWith({ cwd: process.cwd() });
    expect(mocks.createPlatformAgentAi).not.toHaveBeenCalled();
    expect(mocks.createMeteredAi.mock.calls[0]?.[0]).toBe(gatewayAi);
    expect(launchArg()["ai"]).toBe(meteredAi);
  });

  it("a platform session builds the platform AI from the session's scope", async () => {
    mocks.requireSession.mockReturnValue({
      synthetic: false,
      apiUrl: "https://api.test",
      token: "tok_1",
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    await handleSolve("fix the test", {});
    expect(mocks.createPlatformAgentAi).toHaveBeenCalledWith({
      apiUrl: "https://api.test",
      token: "tok_1",
      orgSlug: "acme",
      workspaceSlug: "main",
    });
    expect(mocks.createGatewayAgentAi).not.toHaveBeenCalled();
    expect(mocks.createMeteredAi.mock.calls[0]?.[0]).toBe(platformAi);
  });

  it("folds metered metrics into the usage accumulator and logs to the timeout channel", async () => {
    await handleSolve("fix the test", {});
    const meterOpts = mocks.createMeteredAi.mock.calls[0]?.[1] as {
      onLog: (line: string) => void;
      onMetrics: (ev: unknown) => void;
    };
    const event = { costUsd: 0.5, inputTokens: 100 };
    meterOpts.onMetrics(event);
    expect(usage.record).toHaveBeenCalledWith(event);
    meterOpts.onLog("call took 30s");
    expect(mocks.debugLog).toHaveBeenCalledWith("timeout", "call took 30s");
  });
});

describe("handleSolve — launch options", () => {
  it("defaults: 3 candidates, no models, bare pipeline, no auto-verify, live TUI", async () => {
    await handleSolve("fix the test", {});
    expect(launchArg()).toMatchObject({
      prompt: "fix the test",
      cwd: process.cwd(),
      candidates: 3,
      models: undefined,
      selectorModel: undefined,
      verifyCommand: undefined,
      readOnly: undefined,
      projectContext,
      headless: undefined,
      fullPipeline: false,
      verifyAuto: false,
    });
    expect(launchArg()["usageTotals"]).toBe(usage.totals);
    expect(mocks.loadProjectContext).toHaveBeenCalledWith(process.cwd());
    expect(mocks.debugLog).toHaveBeenCalledWith(
      "turn",
      "solve.start",
      expect.objectContaining({ prompt: "fix the test", candidates: 3 }),
    );
    expect(process.exitCode).toBeUndefined();
  });

  it("--models splits on commas, trims, and drops empties", async () => {
    await handleSolve("t", { models: " a/one, b/two ,,c/three " });
    expect(launchArg()["models"]).toEqual(["a/one", "b/two", "c/three"]);
  });

  it("--model alone becomes a single-entry models list", async () => {
    await handleSolve("t", { model: "anthropic/claude-fable-5" });
    expect(launchArg()["models"]).toEqual(["anthropic/claude-fable-5"]);
  });

  it("--models wins over --model when both are given", async () => {
    await handleSolve("t", { models: "x/a,y/b", model: "z/c" });
    expect(launchArg()["models"]).toEqual(["x/a", "y/b"]);
  });

  it("clamps candidates to at least 1 and at most 10", async () => {
    await handleSolve("t", { candidates: 0 });
    expect(launchArg()["candidates"]).toBe(1);
    mocks.launchBestOfN.mockClear();
    await handleSolve("t", { candidates: 99 });
    expect(launchArg()["candidates"]).toBe(10);
  });

  it("forwards --verify, --selector, --readonly and --json (headless) verbatim", async () => {
    await handleSolve("t", {
      verify: "pnpm test",
      selector: "openai/gpt-5",
      readonly: true,
      json: true,
    });
    expect(launchArg()).toMatchObject({
      verifyCommand: "pnpm test",
      selectorModel: "openai/gpt-5",
      readOnly: true,
      headless: true,
    });
  });

  it("the env opt-ins reach the race when no flags are passed", async () => {
    process.env[PIPELINE_ENV] = "1";
    process.env[VERIFY_ENV] = "1";
    await handleSolve("t", {});
    expect(launchArg()).toMatchObject({ fullPipeline: true, verifyAuto: true });
  });
});

describe("handleSolve — exit contract", () => {
  it("exits 1 when the race produced no viable winner", async () => {
    mocks.launchBestOfN.mockResolvedValue({ selection: { winnerId: null } });
    await handleSolve("t", {});
    expect(process.exitCode).toBe(1);
  });

  it("leaves the exit code untouched when a winner was applied", async () => {
    await handleSolve("t", {});
    expect(process.exitCode).toBeUndefined();
  });
});
