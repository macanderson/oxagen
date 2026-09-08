import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TraceExecutionNode } from "@oxagen/oxagen/contracts/agent.trace.get";

/**
 * Companion to agent.debug.trace.test.ts. That suite stubs `withTenantDb`'s
 * RESULT; this one runs the callbacks against a fake transaction so the
 * tenant-scoped root resolve and the bounded tool-argument scan are exercised,
 * and covers the no-captured-error fallbacks (error class derived from the
 * failure reason rather than from an error event).
 */
const { txQueue } = vi.hoisted(() => ({
  txQueue: { rows: [] as unknown[][] },
}));

function nextRows(): unknown[] {
  return txQueue.rows.shift() ?? [];
}

function makeTx() {
  const b: Record<string, unknown> = {};
  Object.assign(b, {
    select: () => b,
    from: () => b,
    where: () => b,
    limit: async () => nextRows(),
    then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
      Promise.resolve(nextRows()).then(res, rej),
  });
  return b;
}

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => unknown) => fn(makeTx()),
  };
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

import {
  fetchErrorEventsForExecution,
  fetchLogsForExecution,
} from "@oxagen/telemetry";
import { agentTraceGetHandler } from "./agent.trace.get";
import { agentDebugTraceHandler } from "./agent.debug.trace";
import { ExecutionNotFoundError } from "./execution-errors";
import { TEST_CTX as CTX } from "../test-utils/fixtures";

const traceGet = vi.mocked(agentTraceGetHandler);
const fetchErrors = vi.mocked(fetchErrorEventsForExecution);
const fetchLogs = vi.mocked(fetchLogsForExecution);

const ROOT_UUID = "8b1d6a8e-1c3f-4a1b-9c2e-7c5d4e3f2a10";

function tree(over: Partial<TraceExecutionNode> = {}): TraceExecutionNode {
  return {
    executionId: "aex_root",
    status: "failed",
    originType: "chat",
    originId: "o1",
    agentId: null,
    failureReason: "RangeError: index out of bounds",
    startedAt: null,
    completedAt: null,
    latencyMs: 30,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    steps: [],
    children: [],
    ...over,
  } as TraceExecutionNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  txQueue.rows = [];
  traceGet.mockResolvedValue(tree());
  fetchErrors.mockResolvedValue([]);
  fetchLogs.mockResolvedValue([]);
});

describe("agentDebugTraceHandler — tenant-scoped queries", () => {
  it("throws ExecutionNotFoundError when the scoped root select returns no row", async () => {
    txQueue.rows = [[]];
    await expect(
      agentDebugTraceHandler({ executionId: "aex_missing" }, CTX),
    ).rejects.toBeInstanceOf(ExecutionNotFoundError);
  });

  it("resolves the root by UUID and mines file paths from tool-call payloads", async () => {
    txQueue.rows = [
      [{ id: ROOT_UUID, publicId: "aex_root", status: "failed" }],
      [{ id: "uuid-step-1" }],
      [
        // A JSON payload, a raw string payload, and two payloads the scan skips.
        { requestPayload: { path: "packages/agent/src/broken.ts" } },
        { requestPayload: '{"file":"packages/agent/src/other.ts"}' },
        { requestPayload: null },
        { requestPayload: undefined },
      ],
    ];

    const frame = await agentDebugTraceHandler({ executionId: ROOT_UUID }, CTX);

    expect(frame.executionId).toBe("aex_root");
    expect(frame.suspectFiles.map((s) => s.path)).toEqual(
      expect.arrayContaining([
        "packages/agent/src/broken.ts",
        "packages/agent/src/other.ts",
      ]),
    );
    // No captured error events, so the class falls back to the failure reason.
    expect(frame.errorClass).toBe("RangeError");
    expect(frame.message).toBe("RangeError: index out of bounds");
    expect(frame.topFrames).toEqual([]);
    expect(frame.errorEvents).toEqual([]);
  });

  it("skips the tool-call scan entirely when the execution has no steps", async () => {
    txQueue.rows = [
      [{ id: ROOT_UUID, publicId: "aex_root", status: "failed" }],
      [], // no steps ⇒ the second select is never issued
    ];

    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root" },
      CTX,
    );

    expect(frame.suspectFiles).toEqual([]);
  });

  it("skips a payload that cannot be serialized", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    txQueue.rows = [
      [{ id: ROOT_UUID, publicId: "aex_root", status: "failed" }],
      [{ id: "uuid-step-1" }],
      [{ requestPayload: circular }],
    ];

    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root" },
      CTX,
    );

    expect(frame.suspectFiles).toEqual([]);
  });

  it("reports a null error class and message for a clean tree with no failure signal", async () => {
    traceGet.mockResolvedValue(
      tree({ status: "completed", failureReason: null }),
    );
    txQueue.rows = [
      [{ id: ROOT_UUID, publicId: "aex_root", status: "completed" }],
      [],
    ];

    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root" },
      CTX,
    );

    expect(frame.failingStep).toBeNull();
    expect(frame.errorClass).toBeNull();
    expect(frame.message).toBeNull();
    expect(frame.truncated).toMatchObject({ spans: false, frames: false });
  });

  it("picks the most severe captured error, breaking ties on recency", async () => {
    txQueue.rows = [
      [{ id: ROOT_UUID, publicId: "aex_root", status: "failed" }],
      [],
    ];
    fetchErrors.mockResolvedValue([
      {
        errorId: "e1",
        severity: "error",
        source: "runner",
        errorClass: "TypeError",
        message: "older same-severity error",
        stack: "",
        capability: "",
        requestId: "",
        fingerprint: "fp1",
        stepId: null,
        createdAt: "2026-07-06 00:00:01.000",
      },
      {
        errorId: "e2",
        severity: "error",
        source: "runner",
        errorClass: "SyntaxError",
        message: "newer same-severity error",
        stack: "",
        capability: "",
        requestId: "",
        fingerprint: "fp2",
        stepId: null,
        createdAt: "2026-07-06 00:00:09.000",
      },
      {
        errorId: "e3",
        severity: "warn",
        source: "runner",
        errorClass: "WarnError",
        message: "a mere warning",
        stack: "",
        capability: "",
        requestId: "",
        fingerprint: "fp3",
        stepId: null,
        createdAt: "2026-07-06 00:00:10.000",
      },
    ]);

    const frame = await agentDebugTraceHandler(
      { executionId: "aex_root" },
      CTX,
    );

    expect(frame.errorClass).toBe("SyntaxError");
    expect(frame.message).toBe("newer same-severity error");
  });
});
