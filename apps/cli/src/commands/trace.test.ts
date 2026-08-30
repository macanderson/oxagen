/**
 * trace.test.ts — pins `oxagen trace <executionId>`: the API route it fetches
 * (with the execution id URL-encoded), the exact rendered span tree (status
 * marks, ms-vs-seconds durations, token brackets, cost, failure reasons, and
 * the 2-space/4-space indentation of steps, tool calls, and child executions),
 * the `--json` raw dump, and the error contract (404 → "Execution not found",
 * everything else → its message; both exit 1).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandWriter } from "../lib/capture-writer.js";

const apiMock = vi.hoisted(() => {
  /** Mirror of lib/api.js's ApiError — a real class so `instanceof` holds. */
  class ApiError extends Error {
    readonly status: number;
    constructor(message: string, status = 0) {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { apiGetOrThrow: vi.fn(), ApiError };
});
vi.mock("../lib/api.js", () => apiMock);

import { handleTrace } from "./trace.js";

/** A writer that keeps stdout and stderr apart (captureWriter interleaves them). */
function splitWriter(): {
  writer: CommandWriter;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    writer: {
      write: (line) => void out.push(line),
      writeErr: (line) => void err.push(line),
    },
    out,
    err,
  };
}

const toolBash = {
  toolCallId: "tc_1",
  toolName: "bash",
  toolType: "builtin",
  status: "completed",
  latencyMs: 42,
  inputTokens: 10,
  outputTokens: 5,
  requestBytes: 100,
  responseBytes: 200,
  responsePreview: null,
};

const toolCancelled = {
  toolCallId: "tc_2",
  toolName: "web_search",
  toolType: "mcp",
  status: "cancelled",
  latencyMs: null,
  inputTokens: 4,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  responsePreview: null,
};

const stepFailed = {
  stepId: "st_1",
  stepNumber: 1,
  stepType: "model",
  status: "failed",
  failureReason: "tool exploded",
  startedAt: null,
  completedAt: null,
  latencyMs: 1500,
  inputTokens: null,
  outputTokens: 7,
  toolCalls: [toolBash, toolCancelled],
};

const stepQueued = {
  stepId: "st_2",
  stepNumber: 2,
  stepType: "tool",
  status: "queued",
  failureReason: null,
  startedAt: null,
  completedAt: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  toolCalls: [],
};

const childRunning = {
  executionId: "exec_2",
  status: "running",
  originType: "subagent",
  originId: "o2",
  agentId: null,
  failureReason: null,
  startedAt: null,
  completedAt: null,
  latencyMs: null,
  inputTokens: null,
  outputTokens: null,
  estimatedCostUsd: null,
  createdAt: "2026-08-23T00:00:00Z",
  updatedAt: "2026-08-23T00:00:00Z",
  steps: [],
  children: [],
};

const childFailed = {
  executionId: "exec_3",
  status: "failed",
  originType: "a2a",
  originId: "o3",
  agentId: null,
  failureReason: "budget exceeded",
  startedAt: null,
  completedAt: null,
  latencyMs: 2000,
  inputTokens: null,
  outputTokens: null,
  estimatedCostUsd: null,
  createdAt: "2026-08-23T00:00:00Z",
  updatedAt: "2026-08-23T00:00:00Z",
  steps: [],
  children: [],
};

const trace = {
  executionId: "exec_1",
  status: "completed",
  originType: "cli",
  originId: "o1",
  agentId: "ag_1",
  failureReason: null,
  startedAt: "2026-08-23T00:00:00Z",
  completedAt: "2026-08-23T00:00:01Z",
  latencyMs: 999,
  inputTokens: 3,
  outputTokens: 9,
  estimatedCostUsd: "0.1234",
  createdAt: "2026-08-23T00:00:00Z",
  updatedAt: "2026-08-23T00:00:01Z",
  steps: [stepFailed, stepQueued],
  children: [childRunning, childFailed],
};

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("handleTrace", () => {
  it("fetches agent/trace/<id> with the id URL-encoded", async () => {
    apiMock.apiGetOrThrow.mockResolvedValueOnce(trace);
    const { writer } = splitWriter();
    await handleTrace("exec/with slash", {}, writer);
    expect(apiMock.apiGetOrThrow).toHaveBeenCalledWith(
      "agent/trace/exec%2Fwith%20slash",
    );
  });

  it("renders the full span tree — marks, durations, tokens, cost, failure reasons, indentation", async () => {
    apiMock.apiGetOrThrow.mockResolvedValueOnce(trace);
    const { writer, out, err } = splitWriter();
    await handleTrace("exec_1", {}, writer);
    expect(out).toEqual([
      [
        "✓ execution exec_1 [cli] completed 999ms [3→9 tok] $0.1234",
        "  ✗ step 1 model 1.50s [0→7 tok] — tool exploded",
        "      ✓ tool bash (builtin) 42ms [10→5 tok]",
        "      ✗ tool web_search (mcp) — [4→0 tok]",
        "  • step 2 tool —",
        "  ◷ execution exec_2 [subagent] running —",
        "  ✗ execution exec_3 [a2a] failed 2.00s — budget exceeded",
      ].join("\n"),
    ]);
    expect(err).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("--json dumps the raw contract output via the default stdout writer", async () => {
    apiMock.apiGetOrThrow.mockResolvedValueOnce(trace);
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      stdout.push(String(s));
      return true;
    });
    await handleTrace("exec_1", { json: true });
    expect(stdout.join("")).toBe(`${JSON.stringify(trace, null, 2)}\n`);
  });

  it("a 404 becomes 'Execution not found' on stderr and exit code 1", async () => {
    apiMock.apiGetOrThrow.mockRejectedValueOnce(
      new apiMock.ApiError("Error 404 from agent/trace/nope: gone", 404),
    );
    const { writer, out, err } = splitWriter();
    await handleTrace("nope", {}, writer);
    expect(err).toEqual(["Execution not found: nope"]);
    expect(out).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("any other ApiError surfaces its message and exits 1", async () => {
    apiMock.apiGetOrThrow.mockRejectedValueOnce(
      new apiMock.ApiError("Error 500 from agent/trace/x: boom", 500),
    );
    const { writer, err } = splitWriter();
    await handleTrace("x", {}, writer);
    expect(err).toEqual(["Error 500 from agent/trace/x: boom"]);
    expect(process.exitCode).toBe(1);
  });

  it("a non-Error rejection is stringified, never rethrown", async () => {
    apiMock.apiGetOrThrow.mockRejectedValueOnce("wire fell over");
    const { writer, err } = splitWriter();
    await handleTrace("x", {}, writer);
    expect(err).toEqual(["wire fell over"]);
    expect(process.exitCode).toBe(1);
  });
});
