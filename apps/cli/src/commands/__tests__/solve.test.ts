/**
 * `resolveFullPipeline` — the CLI-flag/env-var precedence for whether `solve`
 * candidates run the full evaluate/enhance/judge/revise pipeline or bare.
 * Pure function, no session/AI-port setup needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveFullPipeline } from "../solve.js";

const ENV_VAR = "OXAGEN_BEST_OF_N_PIPELINE";
let original: string | undefined;

beforeEach(() => {
  original = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (original === undefined) delete process.env[ENV_VAR];
  else process.env[ENV_VAR] = original;
});

describe("resolveFullPipeline", () => {
  it("defaults to bare when neither --pipeline nor the env var is set", () => {
    expect(resolveFullPipeline({})).toBe(false);
  });

  it("turns on when OXAGEN_BEST_OF_N_PIPELINE=1, even without the CLI flag", () => {
    process.env[ENV_VAR] = "1";
    expect(resolveFullPipeline({})).toBe(true);
  });

  it("ignores a non-'1' env value (stays bare)", () => {
    process.env[ENV_VAR] = "true";
    expect(resolveFullPipeline({})).toBe(false);
  });

  it("an explicit --pipeline wins regardless of the env var", () => {
    process.env[ENV_VAR] = "0";
    expect(resolveFullPipeline({ pipeline: true })).toBe(true);
  });

  it("an explicit false wins over a truthy env var (defensive — no --no-pipeline flag exists yet, but the precedence must hold if one is added)", () => {
    process.env[ENV_VAR] = "1";
    expect(resolveFullPipeline({ pipeline: false })).toBe(false);
  });
});
