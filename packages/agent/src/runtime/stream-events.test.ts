import { describe, expect, it } from "vitest";
import { isAgentStreamEvent, type AgentStreamEvent } from "./stream-events";

// Exhaustive narrowing: if a variant is missing a required discriminant or
// field, the type-checker / runtime will flag it in this switch.
function summarize(e: AgentStreamEvent): string {
  switch (e.type) {
    case "tool-call-start":
      return `start:${e.callId}:${e.capability}`;
    case "tool-call-output":
      return `out:${e.callId}:${e.chunk.length}`;
    case "tool-call-end":
      return `end:${e.callId}:${e.status}`;
    case "approval-required":
      return `appr:${e.approvalId}:${e.riskLevel}`;
    case "approval-resolved":
      return `appr-r:${e.approvalId}:${e.resolution}`;
    case "plan-proposed":
      return `plan:${e.planId}:${e.title}`;
    case "plan-resolved":
      return `plan-r:${e.planId}:${e.status}`;
    case "subagent-dispatched":
      return `fan:${e.fanoutId}:${e.childMessageIds.length}`;
    case "subagent-aggregated":
      return `agg:${e.fanoutId}:${e.status}`;
    case "background-task-started":
      return `bg:${e.taskId}:${e.kind}`;
  }
}

describe("AgentStreamEvent variants", () => {
  it("narrows every variant through the discriminated union", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool-call-start",
        callId: "c1",
        capability: "execute_code",
        input: {},
      },
      { type: "tool-call-output", callId: "c1", chunk: "hello" },
      {
        type: "tool-call-end",
        callId: "c1",
        capability: "execute_code",
        status: "completed",
        output: { ok: true },
      },
      {
        type: "approval-required",
        approvalId: "a1",
        capability: "execute_code",
        riskLevel: "high",
        inputPreview: {},
      },
      { type: "approval-resolved", approvalId: "a1", resolution: "approved" },
      { type: "plan-proposed", planId: "p1", title: "do the thing", steps: [] },
      { type: "plan-resolved", planId: "p1", status: "approved" },
      {
        type: "subagent-dispatched",
        fanoutId: "f1",
        parentMessageId: "m1",
        childMessageIds: ["c1", "c2"],
      },
      { type: "subagent-aggregated", fanoutId: "f1", status: "completed" },
      {
        type: "background-task-started",
        taskId: "t1",
        kind: "scan",
        inngestRunId: "run_1",
      },
    ];
    const out = events.map(summarize);
    expect(out).toHaveLength(10);
    expect(out[0]).toBe("start:c1:execute_code");
    expect(out[7]).toBe("fan:f1:2");
  });

  it("isAgentStreamEvent accepts well-formed objects", () => {
    expect(isAgentStreamEvent({ type: "tool-call-start" })).toBe(true);
    expect(isAgentStreamEvent(null)).toBe(false);
    expect(isAgentStreamEvent("x")).toBe(false);
    expect(isAgentStreamEvent({})).toBe(false);
  });
});
