// Typed shapes for the interleaved chat stream chunks emitted by the
// agent runtime (see docs/epics/agent-runtime/spec.md §7). Each event is
// rendered inline against the assistant message identified by
// `messageId` / `toolCallId` / `approvalId` / `planId` / `fanoutId`.

export type RiskLevel = "low" | "medium" | "high";

/**
 * Directive emitted by a capability tool result to instruct the chat UI to
 * render a typed React component inline. Capabilities populate this field in
 * their output; the stream route forwards it as a "component" event; the
 * message bubble dispatches to CHAT_COMPONENTS[componentId].
 *
 * Export this type so capability output types can reference the same shape:
 *   import type { RenderDirective } from "@/components/chat/stream-event-types";
 */
export interface RenderDirective {
  componentId: string;
  props: Record<string, unknown>;
}

/**
 * Usage summary emitted in the "done" sentinel so the chat UX can show
 * credits consumed for the current turn.
 */
export interface TurnUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Cost in credits (1 credit = 1¢ USD). Present when billing is wired. */
  creditsCharged?: number;
}

export type ToolCallStatus = "running" | "completed" | "failed";

export type ApprovalResolution = "approved" | "denied" | "expired";

export type PlanDecision = "approved" | "denied" | "amended";

export type SubagentStatus = "running" | "completed" | "partial" | "timed_out";

export type MemoryWeight = "ignore" | "consider" | "fact";

export interface PlanStep {
  id: string;
  summary: string;
  intent: string;
  capability: string | null;
  dependsOn: string[];
  inputPreview?: unknown;
}

export interface MemoryRecallHit {
  id: string;
  lesson: string;
  weight: MemoryWeight | string;
  score: number;
  nodeRef?: string;
}

export interface SubagentChild {
  childMessageId: string;
  capability: string;
  label?: string;
  status?: SubagentStatus;
  resultPreview?: unknown;
}

export type StreamEvent =
  | { type: "text"; messageId: string; text: string }
  | {
      type: "tool-call-start";
      messageId: string;
      toolCallId: string;
      capability: string;
      inputPreview: unknown;
      riskLevel: RiskLevel;
    }
  | {
      type: "tool-call-output";
      toolCallId: string;
      chunk: { channel: "stdout" | "stderr"; data: string };
    }
  | {
      type: "tool-call-end";
      toolCallId: string;
      status: "completed" | "failed";
      output?: unknown;
      errorReason?: string;
      durationMs: number;
    }
  | {
      type: "approval-required";
      approvalId: string;
      capability: string;
      inputPreview: unknown;
      riskLevel: RiskLevel;
      expiresAt: string;
    }
  | {
      type: "approval-resolved";
      approvalId: string;
      resolution: ApprovalResolution;
    }
  | {
      type: "plan-proposed";
      planId: string;
      title: string;
      steps: PlanStep[];
      rationale?: string;
    }
  | { type: "plan-resolved"; planId: string; decision: PlanDecision }
  | {
      type: "subagent-dispatched";
      fanoutId: string;
      parentMessageId: string;
      children: Array<{ childMessageId: string; capability: string; label?: string }>;
    }
  | {
      type: "subagent-completed";
      fanoutId: string;
      status: "completed" | "partial" | "timed_out";
      results?: Array<{ childMessageId: string; output: unknown }>;
    }
  | {
      type: "memory-recalled";
      queryId: string;
      memories: MemoryRecallHit[];
    }
  | {
      type: "memory-written";
      memoryId: string;
      nodeRef: string;
      weight: MemoryWeight | string;
    }
  | {
      /**
       * Emitted when a tool result contains a `render` field. The client
       * renders CHAT_COMPONENTS[componentId] with the given props, wrapped
       * in a React Suspense boundary.
       */
      type: "component";
      /** Correlation key — same as the tool-call-start toolCallId. */
      toolCallId: string;
      componentId: string;
      props: Record<string, unknown>;
    }
  | {
      /**
       * Emitted once per turn, just before the [DONE] sentinel, with the
       * final token + credit usage for the turn. The chat UX uses this to
       * show "credits consumed" inline.
       */
      type: "usage";
      usage: TurnUsage;
    };

// Content-block shapes persisted on `chat.messages.content_blocks` and
// rendered by `message-bubble.tsx`. They mirror the stream events but
// capture terminal state — what the row looked like after the stream
// closed. The bubble dispatch switch reads `block.type` and forwards to
// the matching card component.

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolCallContentBlock {
  type: "tool-call";
  toolCallId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  status: ToolCallStatus;
  output?: unknown;
  stdout?: string;
  stderr?: string;
  errorReason?: string;
  durationMs?: number;
}

export interface CodeExecuteContentBlock {
  type: "code-execute";
  toolCallId: string;
  language: "node" | "python" | "shell" | string;
  code: string;
  status: ToolCallStatus;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  oomKilled?: boolean;
  durationMs?: number;
}

export interface ApprovalRequestContentBlock {
  type: "approval-request";
  approvalId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  expiresAt: string;
  resolution?: ApprovalResolution;
}

export interface PlanContentBlock {
  type: "plan";
  planId: string;
  title: string;
  steps: PlanStep[];
  rationale?: string;
  status: "pending" | PlanDecision;
}

export interface SubagentFanoutContentBlock {
  type: "subagent-fanout";
  fanoutId: string;
  parentMessageId: string;
  children: SubagentChild[];
  status: SubagentStatus;
  results?: Array<{ childMessageId: string; output: unknown }>;
}

export interface MemoryRecallContentBlock {
  type: "memory-recall";
  queryId: string;
  memories: MemoryRecallHit[];
}

/**
 * A persisted component block — the terminal form of a "component" stream
 * event written to `chat.messages.content_blocks`. The bubble renders
 * CHAT_COMPONENTS[componentId] with props, wrapped in Suspense.
 */
export interface ComponentContentBlock {
  type: "component";
  /** Correlation key — matches the tool-call-start toolCallId. */
  toolCallId: string;
  componentId: string;
  props: Record<string, unknown>;
}

export type AssistantContentBlock =
  | TextContentBlock
  | ToolCallContentBlock
  | CodeExecuteContentBlock
  | ApprovalRequestContentBlock
  | PlanContentBlock
  | SubagentFanoutContentBlock
  | MemoryRecallContentBlock
  | ComponentContentBlock;
