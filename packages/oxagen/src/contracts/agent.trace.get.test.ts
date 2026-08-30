import { describe, expect, it } from "vitest";
import { agentTraceGet } from "./agent.trace.get";
import { getCapability } from "../registry";

describe("agent.trace.get capability", () => {
  it("is registered with the expected surfaces and low sensitivity", () => {
    const cap = getCapability("get_execution_trace");
    expect(cap).toBeDefined();
    expect(cap?.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(cap?.mode).toBe("sync");
    expect(cap?.sensitivity).toBe("low");
  });

  it("requires an executionId", () => {
    expect(() => agentTraceGet.input.parse({})).toThrow();
  });

  it("parses an executionId input", () => {
    const parsed = agentTraceGet.input.parse({ executionId: "aex_1" });
    expect(parsed.executionId).toBe("aex_1");
  });

  it("parses a leaf execution output (no steps, no children)", () => {
    const parsed = agentTraceGet.output.parse({
      executionId: "aex_1",
      status: "completed",
      originType: "chat",
      originId: "00000000-0000-4000-8000-000000000001",
      agentId: null,
      failureReason: null,
      startedAt: "2026-06-16T00:00:00.000Z",
      completedAt: "2026-06-16T00:00:04.000Z",
      latencyMs: 4000,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: "0.012000",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:04.000Z",
      steps: [],
      children: [],
    });
    expect(parsed.executionId).toBe("aex_1");
    expect(parsed.steps).toEqual([]);
  });

  it("parses a nested tree: steps → tool calls, plus a child execution", () => {
    const parsed = agentTraceGet.output.parse({
      executionId: "aex_root",
      status: "running",
      originType: "chat",
      originId: "00000000-0000-4000-8000-000000000001",
      agentId: null,
      failureReason: null,
      startedAt: "2026-06-16T00:00:00.000Z",
      completedAt: null,
      latencyMs: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:00:01.000Z",
      steps: [
        {
          stepId: "aes_1",
          stepNumber: 1,
          stepType: "tool_call",
          status: "completed",
          failureReason: null,
          startedAt: "2026-06-16T00:00:01.000Z",
          completedAt: "2026-06-16T00:00:02.000Z",
          latencyMs: 1000,
          inputTokens: 10,
          outputTokens: 5,
          toolCalls: [
            {
              toolCallId: "atc_1",
              toolName: "get_ontology_neighbors",
              toolType: "capability",
              status: "completed",
              latencyMs: 800,
              inputTokens: 4,
              outputTokens: 2,
              requestBytes: 12,
              responseBytes: 34,
              responsePreview: '{"neighbors":[]}',
            },
          ],
        },
      ],
      children: [
        {
          executionId: "aex_child",
          status: "completed",
          originType: "fanout",
          originId: "00000000-0000-4000-8000-000000000002",
          agentId: null,
          failureReason: null,
          startedAt: "2026-06-16T00:00:01.000Z",
          completedAt: "2026-06-16T00:00:03.000Z",
          latencyMs: 2000,
          inputTokens: 20,
          outputTokens: 10,
          estimatedCostUsd: "0.004000",
          createdAt: "2026-06-16T00:00:01.000Z",
          updatedAt: "2026-06-16T00:00:03.000Z",
          steps: [],
          children: [],
        },
      ],
    });
    expect(parsed.steps[0]?.toolCalls[0]?.toolName).toBe(
      "get_ontology_neighbors",
    );
    expect(parsed.children[0]?.executionId).toBe("aex_child");
  });

  it("rejects an invalid status enum", () => {
    expect(() =>
      agentTraceGet.output.parse({
        executionId: "aex_1",
        status: "bogus",
        originType: "chat",
        originId: "x",
        agentId: null,
        failureReason: null,
        startedAt: null,
        completedAt: null,
        latencyMs: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        steps: [],
        children: [],
      }),
    ).toThrow();
  });
});
