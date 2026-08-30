import { describe, expect, it } from "vitest";
import { agentSubagentFanoutGet } from "./agent.subagent_fanout.get";
import { getCapability } from "../registry";

describe("agent.subagent.fanout.get capability", () => {
  it("requires a fanoutId", () => {
    expect(() => agentSubagentFanoutGet.input.parse({})).toThrow();
  });

  it("parses a fanoutId input", () => {
    const parsed = agentSubagentFanoutGet.input.parse({ fanoutId: "fan_1" });
    expect(parsed.fanoutId).toBe("fan_1");
  });

  it("parses a valid output with child runs", () => {
    const parsed = agentSubagentFanoutGet.output.parse({
      fanoutId: "fan_1",
      parentMessageId: "msg_1",
      status: "partial",
      totalChildren: 2,
      completedChildren: 1,
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:01:00.000Z",
      runs: [
        {
          runId: "sar_1",
          capabilityName: "list_agent_tools",
          status: "completed",
          errorReason: null,
          startedAt: "2026-06-16T00:00:01.000Z",
          completedAt: "2026-06-16T00:00:02.000Z",
          durationMs: 1000,
          inputBytes: 2,
          outputBytes: 42,
          outputPreview: '{"tools":[]}',
        },
        {
          runId: "sar_2",
          capabilityName: "recall_memory",
          status: "failed",
          errorReason: "boom",
          startedAt: null,
          completedAt: null,
          durationMs: null,
          inputBytes: 10,
          outputBytes: 0,
          outputPreview: null,
        },
      ],
    });
    expect(parsed.runs).toHaveLength(2);
    expect(parsed.runs[1]?.errorReason).toBe("boom");
  });

  it("rejects an unknown run status", () => {
    expect(() =>
      agentSubagentFanoutGet.output.parse({
        fanoutId: "fan_1",
        parentMessageId: "msg_1",
        status: "completed",
        totalChildren: 1,
        completedChildren: 1,
        createdAt: "2026-06-16T00:00:00.000Z",
        updatedAt: "2026-06-16T00:00:00.000Z",
        runs: [
          {
            runId: "sar_1",
            capabilityName: "x",
            status: "exploded",
            errorReason: null,
            startedAt: null,
            completedAt: null,
            durationMs: null,
            inputBytes: 0,
            outputBytes: 0,
            outputPreview: null,
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("get_subagent_fanout")).toBe(agentSubagentFanoutGet);
  });
});
