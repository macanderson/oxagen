import { describe, expect, it } from "vitest";
import { agentDebugTrace } from "./agent.debug.trace";
import { getCapability } from "../registry";

describe("agent.debug.trace capability", () => {
  it("is registered with the expected surfaces and low sensitivity", () => {
    const cap = getCapability("debug_execution");
    expect(cap).toBeDefined();
    expect(cap?.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(cap?.mode).toBe("sync");
    expect(cap?.sensitivity).toBe("low");
    // Callable mid-mission by the coding agent.
    expect(cap?.agent?.category).toBe("introspection");
  });

  it("requires an executionId and rejects out-of-range depth", () => {
    expect(() => agentDebugTrace.input.parse({})).toThrow();
    expect(() =>
      agentDebugTrace.input.parse({ executionId: "aex_1", depth: 0 }),
    ).toThrow();
    expect(() =>
      agentDebugTrace.input.parse({ executionId: "aex_1", depth: 99 }),
    ).toThrow();
  });

  it("defaults to deterministic-only (summarize undefined)", () => {
    const parsed = agentDebugTrace.input.parse({ executionId: "aex_1" });
    expect(parsed.executionId).toBe("aex_1");
    expect(parsed.summarize).toBeUndefined();
  });

  it("parses a full failure frame with a null diagnosis (deterministic path)", () => {
    const frame = agentDebugTrace.output.parse({
      executionId: "aex_1",
      status: "failed",
      failingStep: {
        stepId: "aes_2",
        stepNumber: 2,
        stepType: "tool",
        toolName: "edit_file",
        toolCallId: "atc_2",
        status: "failed",
        failureReason: "TypeError: boom",
        latencyMs: 20,
      },
      errorClass: "TypeError",
      message: "boom",
      topFrames: [
        {
          functionName: "handle",
          file: "/repo/src/x.ts",
          line: 42,
          column: 10,
          internal: false,
          raw: "at handle (/repo/src/x.ts:42:10)",
        },
      ],
      relatedSpans: [
        {
          kind: "step",
          id: "aes_2",
          label: "step 2 (tool)",
          status: "failed",
          failureReason: "TypeError: boom",
          latencyMs: 20,
        },
      ],
      suspectFiles: [
        {
          path: "/repo/src/x.ts",
          score: 6,
          reasons: ["stack-frame", "tool-arg"],
        },
      ],
      errorEvents: [
        {
          severity: "error",
          source: "runner",
          errorClass: "TypeError",
          message: "boom",
          fingerprint: "fp1",
          stepId: null,
          createdAt: "2026-07-06 00:00:00.000",
        },
      ],
      logsSample: [
        {
          level: "error",
          message: "edit_file failed",
          stepId: null,
          createdAt: "2026-07-06 00:00:00.100",
        },
      ],
      diagnosis: null,
      truncated: {
        spans: false,
        frames: false,
        suspectFiles: false,
        errorEvents: false,
        logs: false,
      },
    });
    expect(frame.suspectFiles[0]?.path).toBe("/repo/src/x.ts");
    expect(frame.diagnosis).toBeNull();
  });

  it("parses a frame carrying an LLM diagnosis (summarize path)", () => {
    const frame = agentDebugTrace.output.parse({
      executionId: "aex_1",
      status: "failed",
      failingStep: null,
      errorClass: null,
      message: null,
      topFrames: [],
      relatedSpans: [],
      suspectFiles: [],
      errorEvents: [],
      logsSample: [],
      diagnosis: {
        problem: "p",
        expectedBehavior: "e",
        rootCauseHypotheses: [{ id: "h1", statement: "s", evidence: "ev" }],
        blastRadius: ["/repo/src/x.ts"],
        diffBudget: 8,
      },
      truncated: {
        spans: false,
        frames: false,
        suspectFiles: false,
        errorEvents: false,
        logs: false,
      },
    });
    expect(frame.diagnosis?.diffBudget).toBe(8);
  });
});
