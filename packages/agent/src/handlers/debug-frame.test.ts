import { describe, expect, it } from "vitest";
import {
  parseStackFrames,
  extractFilePaths,
  rankSuspectFiles,
  suspectFilesFrom,
  flattenSpans,
  findFailingStep,
  clampMessage,
  type StackFrame,
} from "./debug-frame";
import type { TraceExecutionNode } from "@oxagen/oxagen/contracts/agent.trace.get";

describe("parseStackFrames", () => {
  it("parses function + file:line:col frames", () => {
    const stack = [
      "Error: boom",
      "    at doThing (/repo/packages/agent/src/x.ts:12:34)",
      "    at async run (/repo/apps/api/src/app.ts:5:6)",
      "    at /repo/lib/bare.ts:1:2",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames).toHaveLength(3);
    expect(frames[0]).toMatchObject({
      functionName: "doThing",
      file: "/repo/packages/agent/src/x.ts",
      line: 12,
      column: 34,
      internal: false,
    });
    // "async " qualifier is stripped.
    expect(frames[1]).toMatchObject({
      functionName: "run",
      file: "/repo/apps/api/src/app.ts",
      line: 5,
    });
    // Bare location, no function name.
    expect(frames[2]).toMatchObject({
      functionName: null,
      file: "/repo/lib/bare.ts",
      line: 1,
      column: 2,
    });
  });

  it("flags node-internal and native frames", () => {
    const stack = [
      "Error: x",
      "    at process (node:internal/process/task_queues:95:5)",
      "    at fn (native)",
    ].join("\n");
    const frames = parseStackFrames(stack);
    expect(frames[0]!.internal).toBe(true);
    expect(frames[0]!.file).toBe("node:internal/process/task_queues");
    expect(frames[1]!.internal).toBe(true);
    expect(frames[1]!.file).toBeNull();
  });

  it("respects the frame limit and skips the header line", () => {
    const lines = ["Error: many"];
    for (let i = 0; i < 30; i++)
      lines.push(`    at fn${i} (/a/f${i}.ts:${i}:1)`);
    expect(parseStackFrames(lines.join("\n"), 5)).toHaveLength(5);
  });

  it("returns [] for empty / non-string input", () => {
    expect(parseStackFrames("")).toEqual([]);
    expect(parseStackFrames("   ")).toEqual([]);
    // @ts-expect-error exercising the runtime guard
    expect(parseStackFrames(null)).toEqual([]);
  });
});

describe("extractFilePaths", () => {
  it("extracts only allowlisted-extension file tokens, deduped", () => {
    const text =
      'edit {"path":"src/foo.ts"} then read src/foo.ts and version 1.2.3 and bar.py';
    expect(extractFilePaths(text)).toEqual(["src/foo.ts", "bar.py"]);
  });
  it("ignores dotted non-file tokens", () => {
    expect(extractFilePaths("v1.2.3 a.b google.com")).toEqual([]);
  });
  it("handles null/undefined", () => {
    expect(extractFilePaths(null)).toEqual([]);
    expect(extractFilePaths(undefined)).toEqual([]);
  });
});

describe("rankSuspectFiles", () => {
  it("sums weights, sorts desc, and breaks ties by first-seen order", () => {
    const ranked = rankSuspectFiles([
      { path: "a.ts", weight: 4, reason: "stack-frame" },
      { path: "b.ts", weight: 2, reason: "tool-arg" },
      { path: "a.ts", weight: 4, reason: "stack-frame" },
      { path: "c.ts", weight: 8, reason: "stack-frame" },
    ]);
    expect(ranked.map((r) => r.path)).toEqual(["a.ts", "c.ts", "b.ts"]);
    expect(ranked[0]).toMatchObject({
      path: "a.ts",
      score: 8,
      reasons: ["stack-frame ×2"],
    });
  });
});

describe("suspectFilesFrom", () => {
  it("weights project stack frames above node_modules and merges signals", () => {
    const stackFrames: StackFrame[] = [
      {
        functionName: "f",
        file: "/repo/src/target.ts",
        line: 1,
        column: 1,
        internal: false,
        raw: "",
      },
      {
        functionName: "g",
        file: "/repo/node_modules/dep/index.js",
        line: 2,
        column: 2,
        internal: false,
        raw: "",
      },
      {
        functionName: "h",
        file: "node:internal/x",
        line: 3,
        column: 3,
        internal: true,
        raw: "",
      },
    ];
    const out = suspectFilesFrom({
      stackFrames,
      toolArgPaths: ["/repo/src/target.ts"],
      failureText: ["could not read /repo/src/other.ts"],
    });
    // target.ts: 4 (stack) + 2 (tool-arg) = 6; wins. node_modules: 1. other.ts: 2.
    // internal frame contributes nothing.
    expect(out[0]).toMatchObject({ path: "/repo/src/target.ts", score: 6 });
    expect(out.find((f) => f.path === "node:internal/x")).toBeUndefined();
    expect(out.map((f) => f.path)).toContain("/repo/src/other.ts");
  });
});

// ── Span-tree fixtures ────────────────────────────────────────────────────────
function node(
  partial: Partial<TraceExecutionNode> & { executionId: string },
): TraceExecutionNode {
  return {
    executionId: partial.executionId,
    status: partial.status ?? "completed",
    originType: partial.originType ?? "chat",
    originId: partial.originId ?? "o1",
    agentId: null,
    failureReason: partial.failureReason ?? null,
    startedAt: null,
    completedAt: null,
    latencyMs: partial.latencyMs ?? null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    steps: partial.steps ?? [],
    children: partial.children ?? [],
  };
}

describe("flattenSpans + findFailingStep", () => {
  const tree = node({
    executionId: "aex_root",
    status: "failed",
    steps: [
      {
        stepId: "aes_1",
        stepNumber: 1,
        stepType: "tool",
        status: "completed",
        failureReason: null,
        startedAt: null,
        completedAt: null,
        latencyMs: 10,
        inputTokens: null,
        outputTokens: null,
        toolCalls: [
          {
            toolCallId: "atc_1",
            toolName: "read_file",
            toolType: "capability",
            status: "completed",
            latencyMs: 5,
            inputTokens: null,
            outputTokens: null,
            requestBytes: 0,
            responseBytes: 0,
            responsePreview: null,
          },
        ],
      },
      {
        stepId: "aes_2",
        stepNumber: 2,
        stepType: "tool",
        status: "failed",
        failureReason: "TypeError: cannot read x",
        startedAt: null,
        completedAt: null,
        latencyMs: 20,
        inputTokens: null,
        outputTokens: null,
        toolCalls: [
          {
            toolCallId: "atc_2",
            toolName: "edit_file",
            toolType: "capability",
            status: "failed",
            latencyMs: 7,
            inputTokens: null,
            outputTokens: null,
            requestBytes: 0,
            responseBytes: 0,
            responsePreview: null,
          },
        ],
      },
    ],
  });

  it("flattens failed spans first, then the rest", () => {
    const spans = flattenSpans(tree);
    // Failed root execution + failed step + failed tool call sort ahead.
    const failedKinds = spans
      .filter((s) => s.status === "failed")
      .map((s) => s.id);
    expect(failedKinds).toEqual(["aex_root", "aes_2", "atc_2"]);
    expect(spans[0]!.status).toBe("failed");
    // Labels are human, never bare ids.
    expect(spans.find((s) => s.id === "aes_2")?.label).toBe("step 2 (tool)");
  });

  it("finds the first failed step with its failed tool call attached", () => {
    const failing = findFailingStep(tree);
    expect(failing).toMatchObject({
      stepId: "aes_2",
      stepNumber: 2,
      toolName: "edit_file",
      toolCallId: "atc_2",
      failureReason: "TypeError: cannot read x",
    });
  });

  it("returns null when nothing failed", () => {
    expect(findFailingStep(node({ executionId: "aex_ok" }))).toBeNull();
  });
});

describe("clampMessage", () => {
  it("truncates over the cap and passes null through", () => {
    expect(clampMessage(null)).toBeNull();
    expect(clampMessage("short")).toBe("short");
    expect(clampMessage("x".repeat(700))?.endsWith("… [truncated]")).toBe(true);
  });
});
