// Typed interleaved events the chat stream emits alongside model tokens.
// The frontend matches on `type` to render tool-call cards, approval prompts
// and MCP consent prompts inline in the message DAG.
//
// This is the governance vocabulary and nothing more (ADR-043): Oxagen governs
// agents, it does not run them, so there are no plan, subagent-fanout,
// background-task or sandbox/terminal events here. Every variant below
// corresponds to a gate `materializeTools` actually applies per tool call —
// invoke, approve, consent — so the client can only render what the runtime
// can actually produce.

export type AgentStreamEvent =
  | {
      type: "tool-call-start";
      callId: string;
      capability: string;
      input: unknown;
    }
  | {
      type: "tool-call-end";
      callId: string;
      capability: string;
      status: "completed" | "failed" | "cancelled" | "timed_out";
      output: unknown;
      error?: string;
    }
  | {
      type: "approval-required";
      approvalId: string;
      capability: string;
      riskLevel: "low" | "medium" | "high";
      inputPreview: unknown;
    }
  | {
      type: "approval-resolved";
      approvalId: string;
      resolution: "approved" | "denied" | "expired";
    }
  | {
      // First-use consent for an external MCP tool (or an agent-RBAC "ask"
      // rule). Mirrors MaterializeOptions.onConsentRequired's payload.
      type: "consent-required";
      approvalId: string;
      capability: string;
      serverId: string;
      toolName: string;
      inputPreview: unknown;
    }
  | {
      type: "consent-resolved";
      approvalId: string;
      resolution: "granted" | "denied" | "expired";
    };

export function isAgentStreamEvent(x: unknown): x is AgentStreamEvent {
  return Boolean(x) && typeof x === "object" && "type" in (x as object);
}
