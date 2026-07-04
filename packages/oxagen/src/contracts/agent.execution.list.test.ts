import { describe, expect, it } from "vitest";
import { agentExecutionList } from "./agent.execution.list";
import { getCapability } from "../registry";

describe("agent.execution.list capability", () => {
  it("is registered read-only with the expected surfaces", () => {
    const cap = getCapability("agent.execution.list");
    expect(cap).toBeDefined();
    expect(cap?.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(cap?.sensitivity).toBe("low");
  });

  it("defaults limit to 25", () => {
    const parsed = agentExecutionList.input.parse({});
    expect(parsed.limit).toBe(25);
  });

  it("rejects a limit over 100", () => {
    expect(() => agentExecutionList.input.parse({ limit: 101 })).toThrow();
  });

  it("accepts an ISO before cursor and a status filter", () => {
    const parsed = agentExecutionList.input.parse({
      before: "2026-06-16T00:00:00.000Z",
      status: "completed",
    });
    expect(parsed.before).toBe("2026-06-16T00:00:00.000Z");
    expect(parsed.status).toBe("completed");
  });

  it("parses a page output with nextCursor", () => {
    const parsed = agentExecutionList.output.parse({
      executions: [
        {
          executionId: "aex_1",
          status: "completed",
          originType: "chat",
          originId: "00000000-0000-4000-8000-000000000001",
          agentId: null,
          startedAt: "2026-06-16T00:00:00.000Z",
          completedAt: "2026-06-16T00:00:04.000Z",
          latencyMs: 4000,
          inputTokens: 100,
          outputTokens: 50,
          estimatedCostUsd: "0.012000",
          createdAt: "2026-06-16T00:00:00.000Z",
        },
      ],
      nextCursor: "2026-06-16T00:00:00.000Z",
    });
    expect(parsed.executions).toHaveLength(1);
    expect(parsed.nextCursor).toBe("2026-06-16T00:00:00.000Z");
  });
});
