import { describe, expect, it } from "vitest";
import { isAgentStreamEvent, type AgentStreamEvent } from "./stream-events";

// Exhaustive narrowing: if a variant is missing a required discriminant or
// field, the type-checker / runtime will flag it in this switch.
function summarize(e: AgentStreamEvent): string {
  switch (e.type) {
    case "tool-call-start":
      return `start:${e.callId}:${e.capability}`;
    case "tool-call-end":
      return `end:${e.callId}:${e.status}`;
    case "approval-required":
      return `appr:${e.approvalId}:${e.riskLevel}`;
    case "approval-resolved":
      return `appr-r:${e.approvalId}:${e.resolution}`;
    case "consent-required":
      return `cons:${e.approvalId}:${e.serverId}:${e.toolName}`;
    case "consent-resolved":
      return `cons-r:${e.approvalId}:${e.resolution}`;
  }
}

describe("AgentStreamEvent variants", () => {
  it("narrows every variant through the discriminated union", () => {
    const events: AgentStreamEvent[] = [
      {
        type: "tool-call-start",
        callId: "c1",
        capability: "recall_memory",
        input: {},
      },
      {
        type: "tool-call-end",
        callId: "c1",
        capability: "recall_memory",
        status: "completed",
        output: { ok: true },
      },
      {
        type: "approval-required",
        approvalId: "a1",
        capability: "delete_agent_def",
        riskLevel: "high",
        inputPreview: {},
      },
      { type: "approval-resolved", approvalId: "a1", resolution: "approved" },
      {
        type: "consent-required",
        approvalId: "a2",
        capability: "mcp.srv_1.search",
        serverId: "srv_1",
        toolName: "search",
        inputPreview: {},
      },
      { type: "consent-resolved", approvalId: "a2", resolution: "granted" },
    ];
    const out = events.map(summarize);
    expect(out).toHaveLength(6);
    expect(out[0]).toBe("start:c1:recall_memory");
    expect(out[4]).toBe("cons:a2:srv_1:search");
  });

  // Governance vocabulary only (ADR-043): no plan / subagent-fanout /
  // background-task / sandbox-terminal events survive the runtime excision.
  it("carries no execution-runtime event variants", () => {
    const types: AgentStreamEvent["type"][] = [
      "tool-call-start",
      "tool-call-end",
      "approval-required",
      "approval-resolved",
      "consent-required",
      "consent-resolved",
    ];
    expect(types).toHaveLength(6);
  });

  it("isAgentStreamEvent accepts well-formed objects", () => {
    expect(isAgentStreamEvent({ type: "tool-call-start" })).toBe(true);
    expect(isAgentStreamEvent(null)).toBe(false);
    expect(isAgentStreamEvent("x")).toBe(false);
    expect(isAgentStreamEvent({})).toBe(false);
  });
});
