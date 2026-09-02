import { describe, expect, it } from "vitest";
import { agentSubagentFanoutList } from "./agent.subagent_fanout.list";
import { getCapability } from "../registry";

describe("agent.subagent.fanout.list capability", () => {
  it("defaults limit and leaves parentMessageId optional", () => {
    const parsed = agentSubagentFanoutList.input.parse({});
    expect(parsed.limit).toBe(50);
    expect(parsed.parentMessageId).toBeUndefined();
  });

  it("accepts a parentMessageId filter and custom limit", () => {
    const parsed = agentSubagentFanoutList.input.parse({
      parentMessageId: "msg_1",
      limit: 10,
    });
    expect(parsed.parentMessageId).toBe("msg_1");
    expect(parsed.limit).toBe(10);
  });

  it("rejects a limit above the cap", () => {
    expect(() => agentSubagentFanoutList.input.parse({ limit: 500 })).toThrow();
  });

  it("parses a valid output", () => {
    const parsed = agentSubagentFanoutList.output.parse({
      fanouts: [
        {
          fanoutId: "fan_1",
          parentMessageId: "msg_1",
          status: "running",
          totalChildren: 3,
          completedChildren: 1,
          createdAt: "2026-06-16T00:00:00.000Z",
          updatedAt: "2026-06-16T00:01:00.000Z",
        },
      ],
    });
    expect(parsed.fanouts[0]?.status).toBe("running");
  });

  it("rejects an unknown fanout status", () => {
    expect(() =>
      agentSubagentFanoutList.output.parse({
        fanouts: [
          {
            fanoutId: "fan_1",
            parentMessageId: "msg_1",
            status: "exploded",
            totalChildren: 1,
            completedChildren: 0,
            createdAt: "2026-06-16T00:00:00.000Z",
            updatedAt: "2026-06-16T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow();
  });

  it("is registered in the capability registry", () => {
    expect(getCapability("list_subagent_fanouts")).toBe(
      agentSubagentFanoutList,
    );
  });
});
