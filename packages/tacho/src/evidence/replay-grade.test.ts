import { describe, expect, it } from "vitest";
import {
  COMPLETENESS_GAP_KINDS,
  computeReplayGrade,
  gradeAllows,
  isCompletenessGapKind,
  isContentBearingFrame,
  isReplayGrade,
  REPLAY_GRADES,
  replayGradeRank,
} from "./replay-grade";

const clean = {
  gaps: [] as string[],
  enforcementTier: "gateway" as const,
  harnessReproducible: false,
  retainedBodies: 2,
};

describe("computeReplayGrade", () => {
  it("grades a gapless gateway run fork", () => {
    expect(computeReplayGrade(clean)).toBe("fork");
  });

  it("grades retry only when the harness reports a reproducible run", () => {
    expect(computeReplayGrade({ ...clean, harnessReproducible: true })).toBe(
      "retry",
    );
    expect(
      computeReplayGrade({
        ...clean,
        enforcementTier: "harness",
        harnessReproducible: true,
      }),
    ).toBe("view");
  });

  it("caps a harness-tier run with every body at view", () => {
    expect(computeReplayGrade({ ...clean, enforcementTier: "harness" })).toBe(
      "view",
    );
  });

  it("grades an observe-tier run inspect whatever its bodies (spec §8.4)", () => {
    expect(computeReplayGrade({ ...clean, enforcementTier: "observe" })).toBe(
      "inspect",
    );
    expect(
      computeReplayGrade({
        ...clean,
        enforcementTier: "observe",
        harnessReproducible: true,
      }),
    ).toBe("inspect");
  });

  it("grades inspect when no body was retained: view needs bytes to read (spec §8.4)", () => {
    expect(computeReplayGrade({ ...clean, retainedBodies: 0 })).toBe("inspect");
    expect(
      computeReplayGrade({
        ...clean,
        enforcementTier: "harness",
        retainedBodies: 0,
      }),
    ).toBe("inspect");
  });

  it("drops to view when tool result bodies are missing", () => {
    expect(computeReplayGrade({ ...clean, gaps: ["tool_bodies"] })).toBe(
      "view",
    );
  });

  it.each([
    "digest_only",
    "body_missing",
    "model_calls",
    "hooks_partial",
    "unobserved_tail",
    "chain_break",
    "telemetry_gap",
  ] as const)("grades inspect on a %s gap whatever else holds", (gap) => {
    expect(
      computeReplayGrade({ ...clean, gaps: [gap], harnessReproducible: true }),
    ).toBe("inspect");
    expect(computeReplayGrade({ ...clean, gaps: ["tool_bodies", gap] })).toBe(
      "inspect",
    );
  });

  it("refuses a gap kind outside the vocabulary", () => {
    expect(() =>
      computeReplayGrade({ ...clean, gaps: ["bodies_lost"] }),
    ).toThrow(/unknown completeness gap kind: bodies_lost/);
  });

  it("ignores a repeated gap", () => {
    expect(
      computeReplayGrade({ ...clean, gaps: ["tool_bodies", "tool_bodies"] }),
    ).toBe("view");
  });
});

describe("the ladder", () => {
  it("is ordered weakest first", () => {
    expect(REPLAY_GRADES).toEqual(["inspect", "view", "fork", "retry"]);
    expect(replayGradeRank("inspect")).toBe(0);
    expect(replayGradeRank("retry")).toBe(3);
  });

  it("unlocks every weaker verb and nothing stronger", () => {
    expect(gradeAllows("fork", "view")).toBe(true);
    expect(gradeAllows("fork", "fork")).toBe(true);
    expect(gradeAllows("view", "fork")).toBe(false);
    expect(gradeAllows(null, "inspect")).toBe(false);
  });

  it("recognises the closed vocabularies", () => {
    for (const grade of REPLAY_GRADES) expect(isReplayGrade(grade)).toBe(true);
    expect(isReplayGrade("replay")).toBe(false);
    expect(isReplayGrade(1)).toBe(false);
    for (const kind of COMPLETENESS_GAP_KINDS)
      expect(isCompletenessGapKind(kind)).toBe(true);
    expect(isCompletenessGapKind("bodies")).toBe(false);
  });

  it("names the content-bearing frames of both recorders", () => {
    for (const type of [
      "model.call_completed",
      "tool.call_completed",
      "llm_call",
      "tool_call",
    ])
      expect(isContentBearingFrame(type)).toBe(true);
    expect(isContentBearingFrame("tool_requested")).toBe(false);
    expect(isContentBearingFrame("agent_start")).toBe(false);
    expect(isContentBearingFrame("context.frames_selected")).toBe(false);
  });
});
