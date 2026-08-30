// Typed interleaved events the chat stream emits alongside model tokens.
// The frontend matches on `type` to render tool-call cards, approval
// prompts, plan proposals, and subagent fanouts inline in the DAG.

export type AgentStreamEvent =
  | {
      type: "tool-call-start";
      callId: string;
      capability: string;
      input: unknown;
    }
  | {
      type: "tool-call-output";
      callId: string;
      chunk: string;
      channel?: "stdout" | "stderr";
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
  | { type: "plan-proposed"; planId: string; title: string; steps: unknown }
  | {
      type: "plan-resolved";
      planId: string;
      status: "approved" | "denied" | "amended";
    }
  | {
      type: "subagent-dispatched";
      fanoutId: string;
      parentMessageId: string;
      childMessageIds: string[];
    }
  | {
      type: "subagent-aggregated";
      fanoutId: string;
      status: "pending" | "completed" | "partial" | "timed_out";
    }
  | {
      type: "background-task-started";
      taskId: string;
      kind: string;
      inngestRunId: string;
    };

export function isAgentStreamEvent(x: unknown): x is AgentStreamEvent {
  return Boolean(x) && typeof x === "object" && "type" in (x as object);
}
