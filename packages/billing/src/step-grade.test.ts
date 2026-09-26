// step-grade.test.ts — the step grader and the repeat rule it shares with
// the findings job (#3984, ADR-199).
import { describe, expect, it } from "vitest";
import type { ToolCallFrame } from "./cost-rollup";
import {
  gradeSteps,
  RepeatedCalls,
  repeatKindOf,
  SHELL_TOOL,
} from "./step-grade";

/** A tool call that ran and returned, read-only unless a test says otherwise. */
function call(over: Partial<ToolCallFrame> = {}): ToolCallFrame {
  return {
    name: "Read",
    status: "ok",
    inputDigest: "sha256:in",
    outputDigest: "sha256:out",
    isMutating: false,
    resultTokens: null,
    ...over,
  };
}

describe("gradeSteps", () => {
  it("answers null for a run with no step", () => {
    expect(gradeSteps({ modelCalls: 0, toolCalls: [], retries: 3 })).toBeNull();
  });

  it("counts every step as advanced when nothing failed, repeated or retried", () => {
    expect(
      gradeSteps({
        modelCalls: 2,
        toolCalls: [
          call({ inputDigest: "sha256:a" }),
          call({ inputDigest: "sha256:b" }),
        ],
        retries: 0,
      }),
    ).toEqual({
      advanced: 4,
      unproductive: 0,
      causes: { failed: 0, repeated: 0, retried: 0 },
    });
  });

  it("counts a failed and a rejected call as failed", () => {
    const grade = gradeSteps({
      modelCalls: 1,
      toolCalls: [
        call({ status: "error", inputDigest: "sha256:a" }),
        call({ status: "rejected", inputDigest: "sha256:b" }),
        call({ inputDigest: "sha256:c" }),
      ],
      retries: null,
    });
    expect(grade?.causes).toEqual({ failed: 2, repeated: 0, retried: 0 });
    expect(grade?.advanced).toBe(2);
  });

  it("counts a read-only call that returned what an identical earlier call returned as repeated", () => {
    const grade = gradeSteps({
      modelCalls: 0,
      toolCalls: [call(), call(), call()],
      retries: null,
    });
    // The first call did the work; the two after it read what it already had.
    expect(grade?.causes.repeated).toBe(2);
    expect(grade?.advanced).toBe(1);
  });

  it("does not count a repeat of a call that writes", () => {
    const grade = gradeSteps({
      modelCalls: 0,
      toolCalls: [
        call({ name: "Edit", isMutating: true }),
        call({ name: "Edit", isMutating: true }),
        call({ name: "Write", isMutating: null }),
        call({ name: "Write", isMutating: null }),
      ],
      retries: null,
    });
    expect(grade?.causes.repeated).toBe(0);
    expect(grade?.advanced).toBe(4);
  });

  it("counts a re-run shell command whatever the classifier said, as the findings job does", () => {
    const grade = gradeSteps({
      modelCalls: 0,
      toolCalls: [
        call({ name: SHELL_TOOL, isMutating: true }),
        call({ name: SHELL_TOOL, isMutating: true }),
      ],
      retries: null,
    });
    expect(grade?.causes.repeated).toBe(1);
  });

  it("does not call a repeat one when the output changed or was not recorded", () => {
    const grade = gradeSteps({
      modelCalls: 0,
      toolCalls: [
        call({ outputDigest: "sha256:v1" }),
        call({ outputDigest: "sha256:v2" }),
        call({ outputDigest: null }),
        call({ outputDigest: null }),
      ],
      retries: null,
    });
    expect(grade?.causes.repeated).toBe(0);
  });

  it("counts a step whose frame hides its outcome as advanced", () => {
    const hidden = call({
      name: null,
      status: null,
      inputDigest: null,
      outputDigest: null,
      isMutating: null,
    });
    expect(
      gradeSteps({ modelCalls: 0, toolCalls: [hidden, hidden], retries: null }),
    ).toEqual({
      advanced: 2,
      unproductive: 0,
      causes: { failed: 0, repeated: 0, retried: 0 },
    });
  });

  it("counts a failed repeat once, as failed", () => {
    const grade = gradeSteps({
      modelCalls: 0,
      toolCalls: [call(), call({ status: "error" })],
      retries: null,
    });
    expect(grade?.causes).toEqual({ failed: 1, repeated: 0, retried: 0 });
  });

  it("charges one model call per retry, never more than the run made", () => {
    expect(
      gradeSteps({ modelCalls: 3, toolCalls: [], retries: 2 })?.causes.retried,
    ).toBe(2);
    expect(
      gradeSteps({ modelCalls: 3, toolCalls: [], retries: 9 })?.causes.retried,
    ).toBe(3);
    expect(
      gradeSteps({ modelCalls: 3, toolCalls: [], retries: null })?.causes
        .retried,
    ).toBe(0);
  });

  it("sums advanced and unproductive to the run's steps with every cause present", () => {
    const toolCalls = [
      call({ inputDigest: "sha256:a" }),
      call({ inputDigest: "sha256:a" }),
      call({ status: "error", inputDigest: "sha256:b" }),
      call({ status: "rejected", inputDigest: "sha256:c" }),
      call({ name: "Edit", isMutating: true }),
    ];
    const grade = gradeSteps({ modelCalls: 4, toolCalls, retries: 7 });
    expect(grade).not.toBeNull();
    if (grade === null) return;
    const { failed, repeated, retried } = grade.causes;
    expect({ failed, repeated, retried }).toEqual({
      failed: 2,
      repeated: 1,
      retried: 4,
    });
    expect(failed + repeated + retried).toBe(grade.unproductive);
    expect(grade.advanced + grade.unproductive).toBe(4 + toolCalls.length);
  });
});

describe("repeatKindOf", () => {
  it("files a shell command as shell, a read-only call as read, and anything else as neither", () => {
    expect(repeatKindOf({ tool: SHELL_TOOL, isMutating: true })).toBe("shell");
    expect(repeatKindOf({ tool: "Read", isMutating: false })).toBe("read");
    expect(repeatKindOf({ tool: "Edit", isMutating: true })).toBeNull();
    expect(repeatKindOf({ tool: "Grep", isMutating: null })).toBeNull();
  });
});

describe("RepeatedCalls", () => {
  it("keeps one scope's calls apart from another's", () => {
    const seen = new RepeatedCalls();
    expect(seen.repeats("tse_a", "Read", "sha256:in", "sha256:out")).toBe(
      false,
    );
    expect(seen.repeats("tse_b", "Read", "sha256:in", "sha256:out")).toBe(
      false,
    );
    expect(seen.repeats("tse_a", "Read", "sha256:in", "sha256:out")).toBe(true);
  });

  it("remembers every output an input returned", () => {
    const seen = new RepeatedCalls();
    seen.repeats("", "Read", "sha256:in", "sha256:v1");
    seen.repeats("", "Read", "sha256:in", "sha256:v2");
    expect(seen.repeats("", "Read", "sha256:in", "sha256:v1")).toBe(true);
  });

  it("never treats an unrecorded output as a repeat", () => {
    const seen = new RepeatedCalls();
    seen.repeats("", "Read", "sha256:in", "");
    expect(seen.repeats("", "Read", "sha256:in", "")).toBe(false);
    expect(seen.repeats("", "Read", "sha256:in", null)).toBe(false);
  });
});
