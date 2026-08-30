// harbor-parse.test.ts
//
// Pure-function tests for the Harbor/oxagen artifact parsers. No fs or
// ClickHouse mocking needed — every function here takes already-loaded
// JSON/text and returns a plain value.

import { describe, expect, it } from "vitest";
import {
  agentCostUsd,
  agentNameFromHarborConfig,
  agentSplitTokens,
  agentTotalTokens,
  bareTaskId,
  bestOfNMetadata,
  durationSeconds,
  parseTrajectory,
  parseVerifierReport,
  rewardOf,
  toolCallCount,
  type HarborRunConfig,
  type HarborTaskResult,
  type HarborVerifierReport,
} from "./harbor-parse";

describe("agentNameFromHarborConfig", () => {
  it("derives 'oxagen' from the module:ClassName import path", () => {
    const config: HarborRunConfig = {
      agents: [{ name: "oxagen_swe_bench:OxagenAgent" }],
    };
    expect(agentNameFromHarborConfig(config)).toBe("oxagen");
  });

  it("lowercases the class name and replaces underscores with hyphens", () => {
    const config: HarborRunConfig = {
      agents: [{ name: "some_pkg:Multi_WordAgent" }],
    };
    expect(agentNameFromHarborConfig(config)).toBe("multi-word");
  });

  it("does not hyphenate camelCase word boundaries (only underscores are replaced)", () => {
    const config: HarborRunConfig = {
      agents: [{ name: "some_pkg:MultiWordAgent" }],
    };
    expect(agentNameFromHarborConfig(config)).toBe("multiword");
  });

  it("passes a built-in Harbor agent name through unchanged", () => {
    const config: HarborRunConfig = { agents: [{ name: "claude-code" }] };
    expect(agentNameFromHarborConfig(config)).toBe("claude-code");
  });

  it("returns 'unknown' when no agents are configured", () => {
    expect(agentNameFromHarborConfig({})).toBe("unknown");
    expect(agentNameFromHarborConfig({ agents: [] })).toBe("unknown");
  });
});

describe("bareTaskId", () => {
  it("prefers the structured task_id.name", () => {
    const trial: HarborTaskResult = {
      task_name: "swe-bench/django__django-11099",
      task_id: { org: "swe-bench", name: "django__django-11099" },
    };
    expect(bareTaskId(trial)).toBe("django__django-11099");
  });

  it("falls back to splitting task_name on the last slash", () => {
    const trial: HarborTaskResult = {
      task_name: "swe-bench/django__django-11099",
    };
    expect(bareTaskId(trial)).toBe("django__django-11099");
  });

  it("returns the whole task_name when there is no namespace", () => {
    const trial: HarborTaskResult = { task_name: "hello-world" };
    expect(bareTaskId(trial)).toBe("hello-world");
  });

  it("returns an empty string when nothing is present", () => {
    expect(bareTaskId({})).toBe("");
  });
});

describe("rewardOf", () => {
  it("reads verifier_result.rewards.reward", () => {
    expect(rewardOf({ verifier_result: { rewards: { reward: 1 } } })).toBe(1);
    expect(rewardOf({ verifier_result: { rewards: { reward: 0 } } })).toBe(0);
  });

  it("defaults to 0 when absent or non-finite", () => {
    expect(rewardOf({})).toBe(0);
    expect(rewardOf({ verifier_result: {} })).toBe(0);
    expect(
      rewardOf({ verifier_result: { rewards: { reward: Number.NaN } } }),
    ).toBe(0);
  });
});

describe("agentSplitTokens", () => {
  it("reads the n_input/output/cache split reported by competitor adapters", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        n_input_tokens: 1000,
        n_output_tokens: 300,
        n_cache_tokens: 200,
      },
    };
    expect(agentSplitTokens(trial)).toEqual({ in: 1000, out: 300, cache: 200 });
  });

  it("coerces null/absent split fields (the oxagen shape) to 0", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        n_input_tokens: null,
        n_output_tokens: null,
        n_cache_tokens: null,
      },
    };
    expect(agentSplitTokens(trial)).toEqual({ in: 0, out: 0, cache: 0 });
    expect(agentSplitTokens({})).toEqual({ in: 0, out: 0, cache: 0 });
  });
});

describe("agentTotalTokens", () => {
  it("prefers agent_result.metadata.oxagen_total_tokens (the oxagen path) over the null split", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        n_input_tokens: null,
        n_output_tokens: null,
        n_cache_tokens: null,
        metadata: { oxagen_total_tokens: 506956 },
      },
    };
    expect(agentTotalTokens(trial)).toBe(506956);
  });

  it("falls back to the sum of the split fields when no metadata total is present (the competitor path)", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        n_input_tokens: 1000,
        n_output_tokens: 300,
        n_cache_tokens: 200,
        metadata: {},
      },
    };
    expect(agentTotalTokens(trial)).toBe(1500);
  });

  it("honors an explicit oxagen_total_tokens of 0 rather than silently summing the split", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        n_input_tokens: 5,
        n_output_tokens: 5,
        n_cache_tokens: 5,
        metadata: { oxagen_total_tokens: 0 },
      },
    };
    // A present-and-finite 0 is authoritative; a non-numeric value is treated as absent.
    expect(agentTotalTokens(trial)).toBe(0);
  });

  it("returns 0 when neither a metadata total nor any split is available", () => {
    expect(agentTotalTokens({})).toBe(0);
    expect(agentTotalTokens({ agent_result: { metadata: {} } })).toBe(0);
  });
});

describe("agentCostUsd", () => {
  it("reads agent_result.cost_usd", () => {
    expect(agentCostUsd({ agent_result: { cost_usd: 1.62 } })).toBe(1.62);
  });

  it("defaults to 0 when null, absent, or non-finite", () => {
    expect(agentCostUsd({ agent_result: { cost_usd: null } })).toBe(0);
    expect(agentCostUsd({ agent_result: {} })).toBe(0);
    expect(agentCostUsd({})).toBe(0);
  });
});

describe("bestOfNMetadata", () => {
  it("reads the oxagen_bestofn_* fields", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        metadata: {
          oxagen_bestofn_candidates: 3,
          oxagen_bestofn_winner_id: "candidate-1",
          oxagen_bestofn_winner_files: 2,
          oxagen_bestofn_winner_steps: 8,
        },
      },
    };
    expect(bestOfNMetadata(trial)).toEqual({
      nCandidates: 3,
      winnerCandidateId: "candidate-1",
      winnerFiles: 2,
      winnerSteps: 8,
    });
  });

  it("defaults to zero/empty when metadata is absent", () => {
    expect(bestOfNMetadata({})).toEqual({
      nCandidates: 0,
      winnerCandidateId: "",
      winnerFiles: 0,
      winnerSteps: 0,
    });
  });

  it("ignores non-numeric/non-string values rather than throwing", () => {
    const trial: HarborTaskResult = {
      agent_result: {
        metadata: {
          oxagen_bestofn_candidates: "three" as unknown as number,
          oxagen_bestofn_winner_id: null as unknown as string,
        },
      },
    };
    expect(bestOfNMetadata(trial)).toEqual({
      nCandidates: 0,
      winnerCandidateId: "",
      winnerFiles: 0,
      winnerSteps: 0,
    });
  });
});

describe("durationSeconds", () => {
  it("prefers agent_execution start/finish over the trial-level timestamps", () => {
    const trial: HarborTaskResult = {
      started_at: "2026-07-03T21:00:00.000Z",
      finished_at: "2026-07-03T21:20:00.000Z",
      agent_execution: {
        started_at: "2026-07-03T21:05:00.000Z",
        finished_at: "2026-07-03T21:06:40.000Z",
      },
    };
    expect(durationSeconds(trial)).toBe(100);
  });

  it("falls back to trial-level timestamps when agent_execution is absent", () => {
    const trial: HarborTaskResult = {
      started_at: "2026-07-03T21:00:00.000Z",
      finished_at: "2026-07-03T21:01:30.000Z",
    };
    expect(durationSeconds(trial)).toBe(90);
  });

  it("returns 0 when timestamps are missing or unparseable", () => {
    expect(durationSeconds({})).toBe(0);
    expect(
      durationSeconds({ started_at: "not-a-date", finished_at: "also-not" }),
    ).toBe(0);
  });

  it("returns 0 rather than a negative duration when finish precedes start", () => {
    const trial: HarborTaskResult = {
      started_at: "2026-07-03T21:10:00.000Z",
      finished_at: "2026-07-03T21:00:00.000Z",
    };
    expect(durationSeconds(trial)).toBe(0);
  });
});

describe("parseVerifierReport", () => {
  const report: HarborVerifierReport = {
    "django__django-11099": {
      resolved: true,
      tests_status: {
        FAIL_TO_PASS: { success: ["test_a"], failure: ["test_b"] },
        PASS_TO_PASS: { success: ["test_c", "test_c"], failure: [] },
      },
    },
  };

  it("looks up the entry by exact task id and unions success+failure per bucket", () => {
    const parsed = parseVerifierReport(report, "django__django-11099");
    expect(parsed.resolved).toBe(true);
    expect(parsed.testSpec.FAIL_TO_PASS.sort()).toEqual(["test_a", "test_b"]);
    // De-duplicated even though "test_c" appeared only once here — proves the
    // union path doesn't blindly concat.
    expect(parsed.testSpec.PASS_TO_PASS).toEqual(["test_c"]);
  });

  it("falls back to the report's only entry when the task id doesn't match verbatim", () => {
    const parsed = parseVerifierReport(report, "some-other-id");
    expect(parsed.resolved).toBe(true);
  });

  it("returns nulls/empty arrays when the report is missing", () => {
    expect(parseVerifierReport(null, "x")).toEqual({
      resolved: null,
      testSpec: { FAIL_TO_PASS: [], PASS_TO_PASS: [] },
    });
    expect(parseVerifierReport(undefined, "x")).toEqual({
      resolved: null,
      testSpec: { FAIL_TO_PASS: [], PASS_TO_PASS: [] },
    });
  });

  it("returns resolved: null when the entry has no explicit resolved flag", () => {
    const parsed = parseVerifierReport({ x: {} }, "x");
    expect(parsed.resolved).toBeNull();
  });

  it("returns resolved: null when the report object has no entries at all", () => {
    const parsed = parseVerifierReport({}, "anything");
    expect(parsed.resolved).toBeNull();
    expect(parsed.testSpec).toEqual({ FAIL_TO_PASS: [], PASS_TO_PASS: [] });
  });
});

describe("parseTrajectory", () => {
  it("returns an empty result for an empty/blank string", () => {
    expect(parseTrajectory("")).toEqual({
      problemStatement: "",
      winnerCandidateId: "",
      winnerFiles: 0,
      candidates: [],
      aggregateToolCalls: {},
    });
    expect(parseTrajectory("   \n  \n")).toEqual({
      problemStatement: "",
      winnerCandidateId: "",
      winnerFiles: 0,
      candidates: [],
      aggregateToolCalls: {},
    });
  });

  it("extracts the problem statement from the start event", () => {
    const text = '{"type":"start","candidates":1,"prompt":"Fix the bug."}\n';
    expect(parseTrajectory(text).problemStatement).toBe("Fix the bug.");
  });

  it("counts only known tool-call labels, ignoring phase-marker labels", () => {
    const lines = [
      '{"type":"start","candidates":1,"prompt":"p"}',
      '{"type":"candidate-start","id":"candidate-1","model":"m"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"evaluated · completeness 90/100"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"read_file"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"read_file"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"code_graph"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"executing"}',
      '{"type":"result","winnerId":"candidate-1","winnerFiles":["a.py"],"candidates":[{"id":"candidate-1","model":"m","changedFiles":["a.py"],"steps":4,"failed":false}]}',
    ];
    const parsed = parseTrajectory(lines.join("\n"));
    expect(parsed.aggregateToolCalls).toEqual({ read_file: 2, code_graph: 1 });
    expect(parsed.candidates[0]?.toolCalls).toEqual({
      read_file: 2,
      code_graph: 1,
    });
  });

  it("marks the winning candidate and carries steps/changedFiles/failed per candidate", () => {
    const lines = [
      '{"type":"start","candidates":2,"prompt":"p"}',
      '{"type":"candidate-start","id":"candidate-1","model":"model-a"}',
      '{"type":"candidate-start","id":"candidate-2","model":"model-b"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"bash"}',
      '{"type":"result","winnerId":"candidate-2","winnerFiles":["x.py","y.py"],"candidates":[' +
        '{"id":"candidate-1","model":"model-a","changedFiles":[],"steps":3,"failed":true},' +
        '{"id":"candidate-2","model":"model-b","changedFiles":["x.py","y.py"],"steps":9,"failed":false}]}',
    ];
    const parsed = parseTrajectory(lines.join("\n"));
    expect(parsed.winnerCandidateId).toBe("candidate-2");
    expect(parsed.winnerFiles).toBe(2);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.candidates[0]).toMatchObject({
      id: "candidate-1",
      isWinner: false,
      failed: true,
      steps: 3,
      filesChanged: 0,
    });
    expect(parsed.candidates[1]).toMatchObject({
      id: "candidate-2",
      model: "model-b",
      isWinner: true,
      failed: false,
      steps: 9,
      filesChanged: 2,
    });
  });

  it("falls back to the candidate-start model when the result event omits it", () => {
    const lines = [
      '{"type":"candidate-start","id":"candidate-1","model":"model-from-start"}',
      '{"type":"result","winnerId":"candidate-1","winnerFiles":[],"candidates":[{"id":"candidate-1","changedFiles":[],"steps":1,"failed":false}]}',
    ];
    expect(parseTrajectory(lines.join("\n")).candidates[0]?.model).toBe(
      "model-from-start",
    );
  });

  it("ignores malformed JSON lines and non-object lines without throwing", () => {
    const lines = [
      "not json at all",
      "{ this is not valid json",
      '{"type":"start","candidates":1,"prompt":"ok"}',
      "[1,2,3]",
    ];
    expect(() => parseTrajectory(lines.join("\n"))).not.toThrow();
    expect(parseTrajectory(lines.join("\n")).problemStatement).toBe("ok");
  });

  it("falls back safely when the result event's fields are malformed (wrong type or missing)", () => {
    const lines = [
      '{"type":"candidate-start","id":"candidate-1","model":"m"}',
      // winnerId is a number (not a string), winnerFiles is missing, candidates contains a
      // non-object entry (filtered out) and one entry missing id/steps/changedFiles.
      '{"type":"result","winnerId":42,"candidates":["not-an-object",{"model":"m"}]}',
    ];
    const parsed = parseTrajectory(lines.join("\n"));
    expect(parsed.winnerCandidateId).toBe("");
    expect(parsed.winnerFiles).toBe(0);
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]).toMatchObject({
      id: "",
      model: "m",
      steps: 0,
      filesChanged: 0,
      failed: false,
      isWinner: false, // id "" never matches a winnerCandidateId, even one that's also ""
    });
  });

  it("ignores candidate-progress events with a non-string id or label", () => {
    const lines = [
      '{"type":"candidate-progress","id":42,"label":"bash"}',
      '{"type":"candidate-progress","id":"candidate-1","label":7}',
      '{"type":"candidate-progress","id":"candidate-1","label":"bash"}',
    ];
    const parsed = parseTrajectory(lines.join("\n"));
    expect(parsed.aggregateToolCalls).toEqual({ bash: 1 });
  });

  it("defaults candidates to [] when the result event omits the candidates array entirely", () => {
    const parsed = parseTrajectory(
      '{"type":"result","winnerId":"candidate-1"}',
    );
    expect(parsed.candidates).toEqual([]);
    expect(parsed.winnerCandidateId).toBe("candidate-1");
  });

  it("filters out a null entry inside the candidates array", () => {
    const parsed = parseTrajectory(
      '{"type":"result","winnerId":"candidate-1","candidates":[null,{"id":"candidate-1","steps":1,"changedFiles":[],"failed":false}]}',
    );
    expect(parsed.candidates).toHaveLength(1);
    expect(parsed.candidates[0]?.id).toBe("candidate-1");
  });

  it("falls back to '' for a candidate's model when it's missing and no candidate-start ever named one", () => {
    const parsed = parseTrajectory(
      '{"type":"result","winnerId":"candidate-9","candidates":[{"id":"candidate-9","changedFiles":[]}]}',
    );
    expect(parsed.candidates[0]?.model).toBe("");
  });

  it("returns candidates: [] when there is no terminal result event (e.g. a killed run)", () => {
    const lines = [
      '{"type":"start","candidates":2,"prompt":"p"}',
      '{"type":"candidate-start","id":"candidate-1","model":"m"}',
      '{"type":"candidate-progress","id":"candidate-1","label":"bash"}',
    ];
    const parsed = parseTrajectory(lines.join("\n"));
    expect(parsed.candidates).toEqual([]);
    expect(parsed.problemStatement).toBe("p");
    expect(parsed.aggregateToolCalls).toEqual({ bash: 1 });
  });
});

describe("toolCallCount", () => {
  it("returns the count for a known tool", () => {
    expect(toolCallCount({ grep: 3 }, "grep")).toBe(3);
  });

  it("returns 0 for a tool that was never observed", () => {
    expect(toolCallCount({}, "bash")).toBe(0);
  });
});
