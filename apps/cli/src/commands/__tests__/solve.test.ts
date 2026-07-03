/**
 * `resolveFullPipeline` / `resolveVerifyAuto` — the CLI-flag/env-var
 * precedence for whether `solve` candidates run the full evaluate/enhance/
 * judge/revise pipeline (vs. bare) and whether they auto-verify. Pure
 * functions, no session/AI-port setup needed.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveFullPipeline, resolveVerifyAuto } from "../solve.js";

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

describe("resolveVerifyAuto", () => {
  const VERIFY_ENV_VAR = "OXAGEN_BEST_OF_N_VERIFY";
  let originalVerify: string | undefined;

  beforeEach(() => {
    originalVerify = process.env[VERIFY_ENV_VAR];
    delete process.env[VERIFY_ENV_VAR];
  });

  afterEach(() => {
    if (originalVerify === undefined) delete process.env[VERIFY_ENV_VAR];
    else process.env[VERIFY_ENV_VAR] = originalVerify;
  });

  it("defaults to off when neither --verify-auto nor the env var is set", () => {
    expect(resolveVerifyAuto({})).toBe(false);
  });

  it("turns on when OXAGEN_BEST_OF_N_VERIFY=1, even without the CLI flag", () => {
    process.env[VERIFY_ENV_VAR] = "1";
    expect(resolveVerifyAuto({})).toBe(true);
  });

  it("ignores a non-'1' env value (stays off)", () => {
    process.env[VERIFY_ENV_VAR] = "true";
    expect(resolveVerifyAuto({})).toBe(false);
  });

  it("an explicit --verify-auto wins regardless of the env var", () => {
    process.env[VERIFY_ENV_VAR] = "0";
    expect(resolveVerifyAuto({ verifyAuto: true })).toBe(true);
  });

  it("an explicit false wins over a truthy env var", () => {
    process.env[VERIFY_ENV_VAR] = "1";
    expect(resolveVerifyAuto({ verifyAuto: false })).toBe(false);
  });
});
