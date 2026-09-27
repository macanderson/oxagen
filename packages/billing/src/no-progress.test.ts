// no-progress.test.ts — the no-progress limit's loop finder (spend spec,
// detector 1; #4490).
import { describe, expect, it } from "vitest";
import type { ToolCallFrame } from "./cost-rollup";
import {
  findNoProgressLoops,
  noProgressLimitOf,
  noProgressOutcome,
} from "./no-progress";

/** A read-only call that ran and returned the same output each time. */
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

function times(n: number, over: Partial<ToolCallFrame> = {}): ToolCallFrame[] {
  return Array.from({ length: n }, () => call(over));
}

describe("findNoProgressLoops", () => {
  it("records one loop when 20 identical calls meet a limit of 20", () => {
    expect(findNoProgressLoops(times(20), 20)).toEqual([
      {
        tool: "Read",
        inputDigest: "sha256:in",
        outputDigest: "sha256:out",
        loop: 1,
        repeats: 20,
        atCall: 20,
      },
    ]);
  });

  it("records nothing for 19 identical calls under a limit of 20", () => {
    expect(findNoProgressLoops(times(19), 20)).toEqual([]);
  });

  it("raises the count of a loop that keeps going without adding a loop", () => {
    const loops = findNoProgressLoops(times(35), 20);
    expect(loops).toHaveLength(1);
    expect(loops[0]).toMatchObject({ loop: 1, repeats: 35, atCall: 20 });
  });

  it("records a second loop of the same call after a break", () => {
    const calls = [
      ...times(20),
      call({ name: "Edit", isMutating: true }),
      ...times(20),
    ];
    const loops = findNoProgressLoops(calls, 20);
    expect(loops.map((l) => [l.loop, l.repeats, l.atCall])).toEqual([
      [1, 20, 20],
      [2, 20, 41],
    ]);
  });

  it("ends a loop at a file change, and counts calls only in atCall", () => {
    const frames = [
      ...times(20),
      { fileChanged: true as const },
      ...times(20),
    ];
    const loops = findNoProgressLoops(frames, 20);
    expect(loops.map((l) => [l.loop, l.repeats, l.atCall])).toEqual([
      [1, 20, 20],
      [2, 20, 40],
    ]);
  });

  it("finds no loop when a file changes partway (negative)", () => {
    const frames = [...times(10), { fileChanged: true as const }, ...times(10)];
    expect(findNoProgressLoops(frames, 20)).toEqual([]);
  });

  it("numbers loops of different calls separately", () => {
    const calls = [
      ...times(3, { inputDigest: "sha256:a" }),
      ...times(3, { inputDigest: "sha256:b" }),
    ];
    const loops = findNoProgressLoops(calls, 3);
    expect(loops.map((l) => [l.inputDigest, l.loop, l.atCall])).toEqual([
      ["sha256:a", 1, 3],
      ["sha256:b", 1, 6],
    ]);
  });

  it("ends a loop at a mutating call", () => {
    const calls = [
      ...times(10),
      call({ name: "Write", isMutating: true }),
      ...times(10),
    ];
    expect(findNoProgressLoops(calls, 20)).toEqual([]);
  });

  it("ends a loop at a call the classifier said nothing about", () => {
    const calls = [
      ...times(10),
      call({ name: "mcp__db__query", isMutating: null }),
      ...times(10),
    ];
    expect(findNoProgressLoops(calls, 20)).toEqual([]);
  });

  it("ends a loop at a call with no output digest", () => {
    for (const outputDigest of [null, ""]) {
      const calls = [...times(10), call({ outputDigest }), ...times(10)];
      expect(findNoProgressLoops(calls, 20)).toEqual([]);
    }
  });

  it("ends a loop when the output changes", () => {
    const calls = [
      ...times(10),
      call({ outputDigest: "sha256:new" }),
      ...times(10),
    ];
    expect(findNoProgressLoops(calls, 20)).toEqual([]);
  });

  it("counts a shell command whose classifier flag is unset", () => {
    const loops = findNoProgressLoops(
      times(20, { name: "Bash", isMutating: null }),
      20,
    );
    expect(loops).toHaveLength(1);
    expect(loops[0]?.tool).toBe("Bash");
  });

  it("does not count other calls whose classifier flag is unset", () => {
    expect(
      findNoProgressLoops(times(20, { name: "Read", isMutating: null }), 20),
    ).toEqual([]);
  });

  it("does not count calls that alternate", () => {
    const calls = Array.from({ length: 40 }, (_, i) =>
      call({ inputDigest: i % 2 === 0 ? "sha256:a" : "sha256:b" }),
    );
    expect(findNoProgressLoops(calls, 20)).toEqual([]);
  });

  it("finds nothing under a limit below 2 or not a whole number", () => {
    for (const limit of [0, 1, 2.5, Number.NaN]) {
      expect(findNoProgressLoops(times(20), limit)).toEqual([]);
    }
  });
});

describe("noProgressLimitOf", () => {
  it("reads a count and a mode", () => {
    expect(noProgressLimitOf({ repeats: 20, mode: "enforced" })).toEqual({
      repeats: 20,
      mode: "enforced",
    });
  });

  it("states no limit without a row or a count", () => {
    expect(noProgressLimitOf(null)).toBeNull();
    expect(noProgressLimitOf(undefined)).toBeNull();
    expect(noProgressLimitOf({ repeats: null, mode: "enforced" })).toBeNull();
  });

  it("states no limit for a count below 2", () => {
    expect(noProgressLimitOf({ repeats: 1, mode: "observe" })).toBeNull();
  });

  it("reads an unknown mode as observe", () => {
    expect(noProgressLimitOf({ repeats: 20, mode: "strict" })?.mode).toBe(
      "observe",
    );
  });
});

describe("noProgressOutcome", () => {
  it("records paused only when an enforced limit paused the run", () => {
    expect(noProgressOutcome("enforced", true)).toBe("paused");
    expect(noProgressOutcome("enforced", false)).toBe("would_pause");
    expect(noProgressOutcome("observe", true)).toBe("would_pause");
    expect(noProgressOutcome("observe", false)).toBe("would_pause");
  });
});
