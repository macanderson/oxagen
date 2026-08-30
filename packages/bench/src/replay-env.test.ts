// replay-env.test.ts

import { describe, expect, it } from "vitest";
import { buildReplayEnv, formatEnvPrefix, runScriptFor } from "./replay-env";

describe("buildReplayEnv", () => {
  it("maps a full best-of-N config to the run.sh env contract", () => {
    const env = buildReplayEnv({
      models: [
        "anthropic/claude-fable-5",
        "anthropic/claude-fable-5",
        "openai/gpt-5.5-pro",
      ],
      candidates: 3,
      pipeline: true,
      verifyAuto: true,
      effort: "xhigh",
      evaluator: "anthropic/claude-sonnet-5",
      advisor: "openai/gpt-5.5-pro",
      reviseRounds: 2,
      nConcurrent: 4,
      dataset: "swe-bench/swe-bench-verified",
      taskIds: ["django__django-11099"],
    });
    expect(env).toEqual({
      OXAGEN_BEST_OF_N: "1",
      OXAGEN_BEST_OF_N_MODELS:
        "anthropic/claude-fable-5,anthropic/claude-fable-5,openai/gpt-5.5-pro",
      OXAGEN_BEST_OF_N_CANDIDATES: "3",
      OXAGEN_BEST_OF_N_PIPELINE: "1",
      OXAGEN_BEST_OF_N_VERIFY: "1",
      OXAGEN_EFFORT: "xhigh",
      OXAGEN_LLM_EVALUATOR: "anthropic/claude-sonnet-5",
      OXAGEN_LLM_ADVISOR: "openai/gpt-5.5-pro",
      OXAGEN_MAX_REVISE_ROUNDS: "2",
      N_CONCURRENT: "4",
      DATASET: "swe-bench/swe-bench-verified",
      TASK_IDS: "django__django-11099",
    });
  });

  it("falls back to a single-task taskId when taskIds is absent", () => {
    const env = buildReplayEnv({ taskId: "django__django-11133" });
    expect(env.TASK_IDS).toBe("django__django-11133");
  });

  it("omits OXAGEN_BEST_OF_N entirely for a plain one-shot config", () => {
    const env = buildReplayEnv({ model: "anthropic/claude-sonnet-5" });
    expect(env.OXAGEN_BEST_OF_N).toBeUndefined();
    expect(env.OXAGEN_MODEL_SLUG).toBe("anthropic/claude-sonnet-5");
  });

  it("ignores unrecognised keys rather than forwarding them as env vars", () => {
    const env = buildReplayEnv({
      someUnknownFutureKey: "value",
      bundleGitSha: "abc123",
    });
    expect(env).toEqual({});
  });

  it("ignores malformed values (wrong type) rather than throwing", () => {
    expect(() =>
      buildReplayEnv({
        models: "not-an-array" as unknown as string[],
        candidates: "three" as unknown as number,
        pipeline: "yes" as unknown as boolean,
      }),
    ).not.toThrow();
    const env = buildReplayEnv({
      models: "not-an-array" as unknown as string[],
      candidates: "three" as unknown as number,
    });
    expect(env).toEqual({});
  });

  it("returns an empty object for an empty config", () => {
    expect(buildReplayEnv({})).toEqual({});
  });

  it("passes raw env-var-named keys straight through (the shape bench-config.json actually writes)", () => {
    const env = buildReplayEnv({
      OXAGEN_BEST_OF_N: "1",
      OXAGEN_BEST_OF_N_MODELS: "anthropic/claude-fable-5,openai/gpt-5.5-pro",
      OXAGEN_EFFORT: "xhigh",
      DATASET: "swe-bench/swe-bench-verified",
      N_CONCURRENT: 4,
      TASK_IDS: "django__django-11099 django__django-11095",
      OXAGEN_WARM: true,
    });
    expect(env).toEqual({
      OXAGEN_BEST_OF_N: "1",
      OXAGEN_BEST_OF_N_MODELS: "anthropic/claude-fable-5,openai/gpt-5.5-pro",
      OXAGEN_EFFORT: "xhigh",
      DATASET: "swe-bench/swe-bench-verified",
      N_CONCURRENT: "4",
      TASK_IDS: "django__django-11099 django__django-11095",
      OXAGEN_WARM: "1",
    });
  });

  it("drops a raw-keyed boolean false rather than emitting an empty/invalid assignment", () => {
    expect(buildReplayEnv({ OXAGEN_WARM: false })).toEqual({});
  });

  it("lets an explicit raw env-var key win over the conventional mapping for the same setting", () => {
    const env = buildReplayEnv({ effort: "low", OXAGEN_EFFORT: "xhigh" });
    expect(env.OXAGEN_EFFORT).toBe("xhigh");
  });

  it("still fills in the conventional mapping for any setting the raw pass didn't cover", () => {
    const env = buildReplayEnv({
      OXAGEN_EFFORT: "xhigh",
      evaluator: "anthropic/claude-sonnet-5",
    });
    expect(env).toEqual({
      OXAGEN_EFFORT: "xhigh",
      OXAGEN_LLM_EVALUATOR: "anthropic/claude-sonnet-5",
    });
  });

  it("ignores a raw-keyed value of the wrong type (object/array) rather than throwing", () => {
    expect(() =>
      buildReplayEnv({ TASK_IDS: ["a", "b"] as unknown as string }),
    ).not.toThrow();
    expect(
      buildReplayEnv({ TASK_IDS: ["a", "b"] as unknown as string }),
    ).toEqual({});
  });
});

describe("runScriptFor", () => {
  it("builds the repo-relative run.sh path for a bench type", () => {
    expect(runScriptFor("swe-bench")).toBe("bench/swe-bench/run.sh");
    expect(runScriptFor("terminal-bench")).toBe("bench/terminal-bench/run.sh");
  });
});

describe("formatEnvPrefix", () => {
  it('renders KEY="value" pairs space-joined', () => {
    expect(formatEnvPrefix({ FOO: "1", BAR: "a b" })).toBe('FOO="1" BAR="a b"');
  });

  it("escapes embedded quotes and backslashes", () => {
    expect(formatEnvPrefix({ X: 'a"b\\c' })).toBe('X="a\\"b\\\\c"');
  });

  it("returns an empty string for an empty env map", () => {
    expect(formatEnvPrefix({})).toBe("");
  });
});
