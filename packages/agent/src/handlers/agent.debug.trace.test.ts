import { describe, expect, it, vi, beforeEach } from "vitest";
import type { TraceExecutionNode } from "@oxagen/oxagen/contracts/agent.trace.get";

// ── Mocks (the handler composes four collaborators; each is mocked). ──
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return { ...real, withTenantDb: vi.fn() };
});
vi.mock("./agent.trace.get", () => ({ agentTraceGetHandler: vi.fn() }));
vi.mock("@oxagen/telemetry", () => ({
  fetchErrorEventsForExecution: vi.fn(),
  fetchLogsForExecution: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ({
  generateObjectFor: vi.fn(),
  selectModel: vi.fn(() => "model-stub"),
}));

import { withTenantDb } from "@oxagen/database";
import {
  fetchErrorEventsForExecution,
  fetchLogsForExecution,
} from "@oxagen/telemetry";
import { generateObjectFor } from "@oxagen/ai";
import { agentTraceGetHandler } from "./agent.trace.get";
import { agentDebugTraceHandler } from "./agent.debug.trace";
import { ExecutionNotFoundError } from "./subagent-errors";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const wtd = vi.mocked(withTenantDb);
const traceGet = vi.mocked(agentTraceGetHandler);
const fetchErrors = vi.mocked(fetchErrorEventsForExecution);
const fetchLogs = vi.mocked(fetchLogsForExecution);
const genObject = vi.mocked(generateObjectFor);

function failedTree(): TraceExecutionNode {
  return {
    executionId: "aex_root",
    status: "failed",
    originType: "chat",
    originId: "o1",
    agentId: null,
    failureReason: "TypeError: cannot read properties of undefined",
    startedAt: null,
    completedAt: null,
    latencyMs: 30,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    steps: [
      {
        stepId: "aes_2",
        stepNumber: 2,
        stepType: "tool",
        status: "failed",
        failureReason: "TypeError: cannot read properties of undefined",
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
    children: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // 1st withTenantDb call → root resolve; 2nd → tool-arg payloads.
  wtd
    .mockResolvedValueOnce({
      id: "uuid-root",
      publicId: "aex_root",
      status: "failed",
    })
    .mockResolvedValueOnce([{ path: "packages/agent/src/broken.ts" }]);
  traceGet.mockResolvedValue(failedTree());
  fetchErrors.mockResolvedValue([
    {
      errorId: "e1",
      severity: "error",
      source: "runner",
      errorClass: "TypeError",
      message: "cannot read properties of undefined (reading 'x')",
      stack:
        "TypeError: x\n    at handle (/repo/packages/agent/src/broken.ts:42:10)",
      capability: "execute_code",
      requestId: "req-1",
      fingerprint: "fp1",
      stepId: "uuid-step-2",
      createdAt: "2026-07-06 00:00:02.000",
    },
  ]);
  fetchLogs.mockResolvedValue([
    {
      stepId: "uuid-step-2",
      logLevel: "error",
      message: "edit_file failed for /repo/packages/agent/src/broken.ts",
      metadata: "{}",
      createdAt: "2026-07-06 00:00:02.100",
    },
  ]);
});

describe("agentDebugTraceHandler", () => {
  it("throws ExecutionNotFoundError when the execution does not resolve", async () => {
    wtd.mockReset();
    wtd.mockResolvedValueOnce(null);
    await expect(
      agentDebugTraceHandler({ executionId: "aex_missing" }, CTX),
    ).rejects.toBeInstanceOf(ExecutionNotFoundError);
  });

  it("assembles a deterministic frame without calling the model", async () => {
    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root" },
      CTX,
    );

    expect(frame.executionId).toBe("aex_root");
    expect(frame.status).toBe("failed");
    expect(frame.errorClass).toBe("TypeError");
    expect(frame.message).toContain("cannot read properties");
    // Failing step is derived from the trace tree.
    expect(frame.failingStep).toMatchObject({
      stepId: "aes_2",
      toolName: "edit_file",
    });
    // Top frame parsed from the captured error stack.
    expect(frame.topFrames[0]).toMatchObject({
      file: "/repo/packages/agent/src/broken.ts",
      line: 42,
      functionName: "handle",
    });
    // broken.ts appears from the stack frame (weight 4), tool-arg (2) and log (2).
    expect(frame.suspectFiles[0]!.path).toContain("broken.ts");
    expect(frame.suspectFiles[0]!.reasons).toEqual(
      expect.arrayContaining([expect.stringContaining("stack-frame")]),
    );
    // Deterministic default: no diagnosis, no model call.
    expect(frame.diagnosis).toBeNull();
    expect(genObject).not.toHaveBeenCalled();
  });

  it("runs exactly one model call when summarize:true and attaches the diagnosis", async () => {
    genObject.mockResolvedValue({
      object: {
        problem: "edit_file dereferenced undefined",
        expectedBehavior: "edit applies cleanly",
        rootCauseHypotheses: [
          {
            id: "h1",
            statement: "missing null guard",
            evidence: "stack line 42",
          },
        ],
        blastRadius: ["packages/agent/src/broken.ts"],
        diffBudget: 8,
      },
    } as never);

    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root", summarize: true },
      CTX,
    );

    expect(genObject).toHaveBeenCalledTimes(1);
    expect(frame.diagnosis).toMatchObject({ diffBudget: 8 });
    expect(frame.diagnosis?.rootCauseHypotheses[0]!.statement).toBe(
      "missing null guard",
    );
  });

  it("keeps the deterministic frame when the model call throws (summarize:true)", async () => {
    genObject.mockRejectedValue(new Error("gateway down"));
    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root", summarize: true },
      CTX,
    );
    expect(frame.diagnosis).toBeNull();
    expect(frame.errorClass).toBe("TypeError"); // frame intact
  });
});
