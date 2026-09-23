import { describe, expect, it } from "vitest";
import {
  COMPLETENESS_GAP_KINDS,
  computeReplayGrade,
  explainReplayGrade,
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
  it.each(["gateway", "contained"] as const)(
    "grades a gapless %s run fork",
    (enforcementTier) => {
      expect(computeReplayGrade({ ...clean, enforcementTier })).toBe("fork");
    },
  );

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

describe("explainReplayGrade", () => {
  const base = {
    gaps: [] as string[],
    enforcementTier: "gateway" as const,
    retainedBodies: 4,
    harnessReproducible: false,
  };

  it("agrees with computeReplayGrade on every input it is asked", () => {
    for (const tier of ["gateway", "harness", "observe"] as const) {
      for (const gaps of [[], ["tool_bodies"], ["chain_break"]]) {
        for (const bodies of [0, 3]) {
          const input = {
            ...base,
            enforcementTier: tier,
            gaps,
            retainedBodies: bodies,
          };
          expect(explainReplayGrade(input).grade).toBe(
            computeReplayGrade(input),
          );
        }
      }
    }
  });

  it("names what carries each rung it reaches", () => {
    const { grade, ladder } = explainReplayGrade(base);
    expect(grade).toBe("fork");
    expect(ladder.map((r) => [r.grade, r.met, r.reason])).toEqual([
      ["inspect", true, "frames_recorded"],
      ["view", true, "bodies_retained"],
      ["fork", true, "tool_cassette_complete"],
      ["retry", false, "harness_not_reproducible"],
    ]);
  });

  it("names the single thing that stops each rung it does not reach", () => {
    expect(
      explainReplayGrade({ ...base, enforcementTier: "harness" }).ladder[2],
    ).toEqual({
      grade: "fork",
      met: false,
      reason: "enforcement_tier:harness",
    });
    expect(
      explainReplayGrade({ ...base, gaps: ["tool_bodies"] }).ladder[2]?.reason,
    ).toBe("tool_bodies");
    expect(
      explainReplayGrade({ ...base, retainedBodies: 0 }).ladder[1]?.reason,
    ).toBe("no_retained_bodies");
    expect(
      explainReplayGrade({ ...base, enforcementTier: "observe" }).ladder[1]
        ?.reason,
    ).toBe("observe_tier");
  });

  it("carries a blocking gap down the rungs above it, sorted so the reason is stable", () => {
    const ladder = explainReplayGrade({
      ...base,
      gaps: ["chain_break", "body_missing"],
    }).ladder;
    expect(ladder.map((r) => r.met)).toEqual([true, false, false, false]);
    expect(ladder[1]?.reason).toBe("body_missing,chain_break");
    expect(ladder[3]?.reason).toBe("body_missing,chain_break");
  });

  it("refuses a gap kind the vocabulary does not name (negative)", () => {
    expect(() =>
      explainReplayGrade({ ...base, gaps: ["something_new"] }),
    ).toThrow(RangeError);
  });
});

describe("isContentBearingFrame", () => {
  it("counts the engine's own call halves, which a body-less in-app run graded `view` without", () => {
    for (const type of [
      "model.engine_call_started",
      "model.engine_call_completed",
      "tool.engine_call_started",
      "tool.engine_call_completed",
    ]) {
      expect(isContentBearingFrame(type)).toBe(true);
    }
    expect(isContentBearingFrame("turn_start")).toBe(false);
  });
});
