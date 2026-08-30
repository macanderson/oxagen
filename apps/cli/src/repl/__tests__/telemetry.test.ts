/**
 * Unit tests for the full-screen dock's pure telemetry reducer: model-slug
 * recovery from the pipeline's existing StageEvent conventions, phase/step/
 * revise-round tracking, and per-tool call tallies. No Ink, no engine, no
 * timers — see telemetry.ts's own doc comment for why this is pure.
 */
import { describe, it, expect } from "vitest";
import {
  telemetryReducer,
  parseEvaluatorModel,
  parseWorkerModel,
  parseJudgeModel,
  toolBucket,
  INITIAL_TELEMETRY_STATE,
  TRACKED_TOOLS,
  OTHER_TOOLS_KEY,
  ENGINE_DEFAULT_MAX_STEPS,
  type TelemetryState,
} from "../telemetry.js";
import type { StageEvent } from "../../agent/trace.js";

describe("parseEvaluatorModel", () => {
  it("reads the model slug from an evaluate stage's detail", () => {
    const stage: StageEvent = {
      kind: "evaluate",
      label: "evaluated · x",
      detail: "claude-haiku-4-5",
    };
    expect(parseEvaluatorModel(stage)).toBe("claude-haiku-4-5");
  });

  it("returns undefined for the heuristic fallback", () => {
    const stage: StageEvent = {
      kind: "evaluate",
      label: "evaluated · x",
      detail: "heuristic",
    };
    expect(parseEvaluatorModel(stage)).toBeUndefined();
  });

  it("returns undefined for a non-evaluate stage", () => {
    const stage: StageEvent = {
      kind: "route",
      label: "model · balanced (sonnet)",
      detail: "claude-haiku",
    };
    expect(parseEvaluatorModel(stage)).toBeUndefined();
  });

  it("returns undefined when detail is absent", () => {
    const stage: StageEvent = { kind: "evaluate", label: "evaluated · x" };
    expect(parseEvaluatorModel(stage)).toBeUndefined();
  });
});

describe("parseWorkerModel", () => {
  it("extracts the model slug out of a route stage's label", () => {
    const stage: StageEvent = {
      kind: "route",
      label: "model · balanced (claude-sonnet-5)",
      detail: "some rationale",
    };
    expect(parseWorkerModel(stage)).toBe("claude-sonnet-5");
  });

  it("returns undefined for a non-route stage", () => {
    const stage: StageEvent = { kind: "execute", label: "executing" };
    expect(parseWorkerModel(stage)).toBeUndefined();
  });

  it("returns undefined when the label has no parenthesized slug", () => {
    const stage: StageEvent = { kind: "route", label: "model · balanced" };
    expect(parseWorkerModel(stage)).toBeUndefined();
  });
});

describe("parseJudgeModel", () => {
  it("extracts the model slug out of a judge stage's 'advisor: slug' detail", () => {
    const stage: StageEvent = {
      kind: "judge",
      label: "judged complete · 90% confident",
      detail: "advisor: claude-opus-4-8",
    };
    expect(parseJudgeModel(stage)).toBe("claude-opus-4-8");
  });

  it("still extracts the slug when a heuristic suffix trails it", () => {
    const stage: StageEvent = {
      kind: "judge",
      label: "judged complete",
      detail: "advisor: claude-opus-4-8 (heuristic)",
    };
    expect(parseJudgeModel(stage)).toBe("claude-opus-4-8");
  });

  it("returns undefined for a non-judge stage", () => {
    const stage: StageEvent = {
      kind: "revise",
      label: "revising · round 1 (incomplete work)",
    };
    expect(parseJudgeModel(stage)).toBeUndefined();
  });

  it("returns undefined when detail doesn't match the 'advisor: ' convention", () => {
    const stage: StageEvent = {
      kind: "judge",
      label: "judged complete",
      detail: "something else",
    };
    expect(parseJudgeModel(stage)).toBeUndefined();
  });
});

describe("toolBucket", () => {
  it("passes through every tracked tool name unchanged", () => {
    for (const name of TRACKED_TOOLS) {
      expect(toolBucket(name)).toBe(name);
    }
  });

  it("buckets anything else under 'other'", () => {
    expect(toolBucket("list_dir")).toBe(OTHER_TOOLS_KEY);
    expect(toolBucket("dispatch_subagent")).toBe(OTHER_TOOLS_KEY);
  });
});

describe("telemetryReducer", () => {
  it("turn-start resets phase/step/round but preserves models and tool tallies", () => {
    const seeded: TelemetryState = {
      models: { worker: "claude-sonnet-5" },
      turn: {
        phase: "complete",
        step: 12,
        maxStep: ENGINE_DEFAULT_MAX_STEPS,
        reviseRound: 2,
        turnStartedAt: 111,
      },
      tools: { bash: 3 },
    };
    const next = telemetryReducer(seeded, { type: "turn-start", at: 222 });
    expect(next.turn).toEqual({
      phase: "evaluate",
      step: 0,
      maxStep: ENGINE_DEFAULT_MAX_STEPS,
      reviseRound: 0,
      turnStartedAt: 222,
    });
    expect(next.models).toEqual({ worker: "claude-sonnet-5" }); // preserved
    expect(next.tools).toEqual({ bash: 3 }); // preserved (session-cumulative)
  });

  it("stage advances the phase and records a revealed model slug", () => {
    const s1 = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "stage",
      stage: {
        kind: "evaluate",
        label: "evaluated · x",
        detail: "claude-haiku-4-5",
      },
    });
    expect(s1.turn.phase).toBe("evaluate");
    expect(s1.models.planner).toBe("claude-haiku-4-5");

    const s2 = telemetryReducer(s1, {
      type: "stage",
      stage: { kind: "route", label: "model · balanced (claude-sonnet-5)" },
    });
    expect(s2.turn.phase).toBe("route");
    expect(s2.models.worker).toBe("claude-sonnet-5");
    expect(s2.models.planner).toBe("claude-haiku-4-5"); // still remembered

    const s3 = telemetryReducer(s2, {
      type: "stage",
      stage: {
        kind: "judge",
        label: "judged complete",
        detail: "advisor: claude-opus-4-8",
      },
    });
    expect(s3.models.judge).toBe("claude-opus-4-8");
  });

  it("counts each revise stage as one more revision round", () => {
    let state = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "turn-start",
      at: 0,
    });
    state = telemetryReducer(state, {
      type: "stage",
      stage: { kind: "revise", label: "revising · round 1" },
    });
    expect(state.turn.reviseRound).toBe(1);
    state = telemetryReducer(state, {
      type: "stage",
      stage: { kind: "revise", label: "revising · round 2" },
    });
    expect(state.turn.reviseRound).toBe(2);
    // Non-revise stages don't increment it further.
    state = telemetryReducer(state, {
      type: "stage",
      stage: { kind: "execute", label: "executing" },
    });
    expect(state.turn.reviseRound).toBe(2);
  });

  it("tool-call increments the step counter and the specific tool's tally", () => {
    let state = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "tool-call",
      name: "read_file",
    });
    expect(state.turn.step).toBe(1);
    expect(state.tools).toEqual({ read_file: 1 });

    state = telemetryReducer(state, { type: "tool-call", name: "read_file" });
    state = telemetryReducer(state, { type: "tool-call", name: "bash" });
    expect(state.turn.step).toBe(3);
    expect(state.tools).toEqual({ read_file: 2, bash: 1 });
  });

  it("tool-call buckets an untracked tool name under 'other'", () => {
    const state = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "tool-call",
      name: "list_dir",
    });
    expect(state.tools).toEqual({ [OTHER_TOOLS_KEY]: 1 });
  });

  it("turn-end marks the phase complete without touching models/tools", () => {
    const seeded: TelemetryState = {
      models: { worker: "claude-sonnet-5" },
      turn: {
        phase: "judge",
        step: 5,
        maxStep: ENGINE_DEFAULT_MAX_STEPS,
        reviseRound: 0,
        turnStartedAt: 1,
      },
      tools: { bash: 1 },
    };
    const next = telemetryReducer(seeded, { type: "turn-end" });
    expect(next.turn.phase).toBe("complete");
    expect(next.turn.step).toBe(5); // untouched
    expect(next.models).toEqual(seeded.models);
    expect(next.tools).toEqual(seeded.tools);
  });

  it("seed-models populates the MODELS readout before the first turn", () => {
    const next = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "seed-models",
      models: {
        planner: "local",
        worker: "anthropic/claude-sonnet-5",
        judge: "anthropic/claude-fable-5",
      },
    });
    expect(next.models).toEqual({
      planner: "local",
      worker: "anthropic/claude-sonnet-5",
      judge: "anthropic/claude-fable-5",
    });
    expect(next.turn).toEqual(INITIAL_TELEMETRY_STATE.turn);
  });

  it("seed-models overwrites prior slugs (a /model switch re-seeds worker + judge), and stage events still overwrite seeds with actuals", () => {
    let state = telemetryReducer(INITIAL_TELEMETRY_STATE, {
      type: "seed-models",
      models: {
        worker: "anthropic/claude-sonnet-5",
        judge: "anthropic/claude-fable-5",
      },
    });
    state = telemetryReducer(state, {
      type: "seed-models",
      models: {
        worker: "openai/gpt-5.5-pro",
        judge: "anthropic/claude-fable-5",
      },
    });
    expect(state.models.worker).toBe("openai/gpt-5.5-pro");

    // The engine reports the routed worker mid-turn — actuals win over seeds.
    const stage: StageEvent = {
      kind: "route",
      label: "Sonnet · balanced (anthropic/claude-sonnet-5)",
    };
    state = telemetryReducer(state, { type: "stage", stage });
    expect(state.models.worker).toBe("anthropic/claude-sonnet-5");
    expect(state.models.judge).toBe("anthropic/claude-fable-5"); // untouched
  });

  it("is a pure function — never mutates the input state object", () => {
    const state: TelemetryState = {
      models: {},
      turn: {
        phase: "idle",
        step: 0,
        maxStep: ENGINE_DEFAULT_MAX_STEPS,
        reviseRound: 0,
        turnStartedAt: null,
      },
      tools: {},
    };
    const snapshot = JSON.parse(JSON.stringify(state)) as TelemetryState;
    telemetryReducer(state, { type: "tool-call", name: "bash" });
    expect(state).toEqual(snapshot);
  });
});
