import { describe, expect, it } from "vitest";
import { agentSubagentResultGet } from "./agent.subagent_result.get";
import { getCapability } from "../registry";

describe("agent.subagent.result.get capability", () => {
  // ── registration ──────────────────────────────────────────────────────────

  it("is registered under its contract name", () => {
    expect(getCapability("get_subagent_result")).toBe(agentSubagentResultGet);
  });

  it("is a read-only sync capability on api/mcp/agent surfaces", () => {
    expect(agentSubagentResultGet.mode).toBe("sync");
    expect(agentSubagentResultGet.surfaces).toEqual(["api", "mcp", "agent"]);
    expect(agentSubagentResultGet.agent?.requiresApproval).toBe(false);
    expect(agentSubagentResultGet.agent?.riskLevel).toBe("low");
  });

  // ── input ─────────────────────────────────────────────────────────────────

  it("parses input with runId", () => {
    const parsed = agentSubagentResultGet.input.parse({ runId: "sar_abc123" });
    expect(parsed.runId).toBe("sar_abc123");
  });

  it("rejects input missing runId", () => {
    expect(() => agentSubagentResultGet.input.parse({})).toThrow();
  });

  it("rejects a non-string runId", () => {
    expect(() => agentSubagentResultGet.input.parse({ runId: 42 })).toThrow();
  });

  // ── output ────────────────────────────────────────────────────────────────

  const BASE_OUTPUT = {
    runId: "sar_abc",
    fanoutId: "fan_abc",
    capabilityName: "search_web",
    status: "completed" as const,
    summary: "3 hits",
    input: { query: "q" },
    output: { results: ["a"] },
    errorReason: null,
    startedAt: "2024-01-01T00:00:00.000Z",
    completedAt: "2024-01-01T00:01:00.000Z",
  };

  it("parses a completed run with full payloads", () => {
    const parsed = agentSubagentResultGet.output.parse(BASE_OUTPUT);
    expect(parsed.output).toEqual({ results: ["a"] });
    expect(parsed.fanoutId).toBe("fan_abc");
  });

  it("parses a pending run with null output/summary/timestamps", () => {
    const parsed = agentSubagentResultGet.output.parse({
      ...BASE_OUTPUT,
      status: "pending",
      summary: null,
      output: null,
      startedAt: null,
      completedAt: null,
    });
    expect(parsed.status).toBe("pending");
    expect(parsed.summary).toBeNull();
  });

  it("parses a failed run with errorReason", () => {
    const parsed = agentSubagentResultGet.output.parse({
      ...BASE_OUTPUT,
      status: "failed",
      output: null,
      errorReason: "boom",
    });
    expect(parsed.errorReason).toBe("boom");
  });

  it("rejects an unknown status", () => {
    expect(() =>
      agentSubagentResultGet.output.parse({
        ...BASE_OUTPUT,
        status: "exploded",
      }),
    ).toThrow();
  });
});
