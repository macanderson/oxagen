import { describe, expect, it } from "vitest";
import { agentExecutionRecord } from "./agent.execution.record";
import { getCapability } from "../registry";

const BASE_UUID_A = "00000000-0000-0000-0000-000000000001";
const BASE_UUID_B = "00000000-0000-0000-0000-000000000002";
const BASE_UUID_C = "00000000-0000-0000-0000-000000000003";

describe("agent.execution.record capability", () => {
  // ── input: required fields ────────────────────────────────────────────────

  it("parses minimal required input", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: { query: "hello" },
    });
    expect(parsed.agentId).toBe(BASE_UUID_A);
    expect(parsed.status).toBe("completed");
  });

  it("rejects input missing agentId", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "completed",
        inputPayload: {},
      }),
    ).toThrow();
  });

  it("rejects a non-UUID agentId", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: "not-a-uuid",
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "completed",
        inputPayload: {},
      }),
    ).toThrow();
  });

  it("rejects a non-UUID originId", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: BASE_UUID_A,
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: "bad-id",
        status: "completed",
        inputPayload: {},
      }),
    ).toThrow();
  });

  // ── input: status enum ────────────────────────────────────────────────────

  it("accepts status='planning'", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "planning",
      inputPayload: {},
    });
    expect(parsed.status).toBe("planning");
  });

  it("accepts status='running'", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "running",
      inputPayload: {},
    });
    expect(parsed.status).toBe("running");
  });

  it("accepts status='failed'", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "failed",
      inputPayload: {},
    });
    expect(parsed.status).toBe("failed");
  });

  it("accepts status='cancelled'", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "cancelled",
      inputPayload: {},
    });
    expect(parsed.status).toBe("cancelled");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: BASE_UUID_A,
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "queued",
        inputPayload: {},
      }),
    ).toThrow();
  });

  // ── input: optional fields ────────────────────────────────────────────────

  it("accepts optional outputPayload", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: {},
      outputPayload: { result: "done" },
    });
    expect(parsed.outputPayload).toEqual({ result: "done" });
  });

  it("accepts optional failureReason", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "failed",
      inputPayload: {},
      failureReason: "Timeout exceeded",
    });
    expect(parsed.failureReason).toBe("Timeout exceeded");
  });

  it("coerces startedAt from an ISO string", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: {},
      startedAt: "2024-01-01T00:00:00.000Z",
    });
    expect(parsed.startedAt).toBeInstanceOf(Date);
  });

  it("accepts optional latencyMs as nonnegative int", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: {},
      latencyMs: 0,
    });
    expect(parsed.latencyMs).toBe(0);
  });

  it("rejects negative latencyMs", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: BASE_UUID_A,
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "completed",
        inputPayload: {},
        latencyMs: -1,
      }),
    ).toThrow();
  });

  it("accepts optional estimatedCostUsd as nonnegative", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: {},
      estimatedCostUsd: 0.0015,
    });
    expect(parsed.estimatedCostUsd).toBeCloseTo(0.0015);
  });

  // ── input: steps with tool calls ──────────────────────────────────────────

  it("accepts steps with tool calls", () => {
    const parsed = agentExecutionRecord.input.parse({
      agentId: BASE_UUID_A,
      agentVersionId: BASE_UUID_B,
      originType: "user",
      originId: BASE_UUID_C,
      status: "completed",
      inputPayload: {},
      steps: [
        {
          stepNumber: 0,
          stepType: "tool_call",
          status: "completed",
          inputPayload: { q: "x" },
          outputPayload: { r: "y" },
          latencyMs: 100,
          toolCalls: [
            {
              toolName: "web_search",
              toolType: "builtin",
              requestPayload: { query: "test" },
              responsePayload: { results: [] },
              status: "completed",
              latencyMs: 80,
            },
          ],
        },
      ],
    });
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.steps?.[0]?.toolCalls).toHaveLength(1);
  });

  it("rejects a step with negative stepNumber", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: BASE_UUID_A,
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "completed",
        inputPayload: {},
        steps: [
          {
            stepNumber: -1,
            stepType: "tool_call",
            status: "completed",
            inputPayload: {},
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects a tool call with unknown status", () => {
    expect(() =>
      agentExecutionRecord.input.parse({
        agentId: BASE_UUID_A,
        agentVersionId: BASE_UUID_B,
        originType: "user",
        originId: BASE_UUID_C,
        status: "completed",
        inputPayload: {},
        steps: [
          {
            stepNumber: 0,
            stepType: "tool_call",
            status: "completed",
            inputPayload: {},
            toolCalls: [
              {
                toolName: "search",
                toolType: "builtin",
                requestPayload: {},
                status: "cancelled",
              },
            ],
          },
        ],
      }),
    ).toThrow();
  });

  // ── output shape ──────────────────────────────────────────────────────────

  it("parses a valid output", () => {
    const parsed = agentExecutionRecord.output.parse({
      executionId: BASE_UUID_A,
      status: "completed",
      createdAt: "2024-06-01T12:00:00.000Z",
    });
    expect(parsed.executionId).toBe(BASE_UUID_A);
    expect(parsed.status).toBe("completed");
    expect(parsed.createdAt).toBeInstanceOf(Date);
  });

  it("coerces createdAt from an ISO string", () => {
    const parsed = agentExecutionRecord.output.parse({
      executionId: BASE_UUID_A,
      status: "failed",
      createdAt: "2025-01-15T08:30:00.000Z",
    });
    expect(parsed.createdAt).toBeInstanceOf(Date);
    expect(parsed.createdAt.getFullYear()).toBe(2025);
  });

  it("rejects output missing executionId", () => {
    expect(() =>
      agentExecutionRecord.output.parse({
        status: "completed",
        createdAt: "2024-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("rejects output missing createdAt", () => {
    expect(() =>
      agentExecutionRecord.output.parse({
        executionId: BASE_UUID_A,
        status: "completed",
      }),
    ).toThrow();
  });

  // ── registry ──────────────────────────────────────────────────────────────

  it("is registered in the capability registry", () => {
    expect(getCapability("agent.execution.record")).toBe(agentExecutionRecord);
  });
});
