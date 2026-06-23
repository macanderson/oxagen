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

// "pending" is the pre-execution phase while the model is still streaming the
// tool's arguments (tool-input-start → tool-input-delta*); it flips to
// "running" once the full tool-call lands and execution begins. Persisted
// blocks are always terminal ("completed" | "failed"); "pending"/"running"
// only exist on live (in-flight) tool calls.
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export type ApprovalResolution = "approved" | "denied" | "expired";

// External-MCP consent resolution (OXA-816). Distinct vocabulary from
// ApprovalResolution: a consent grant is "granted"/"denied" (not "approved").
export type ConsentResolution = "granted" | "denied" | "expired";

export type PlanDecision = "approved" | "denied" | "amended";

export type SubagentStatus = "running" | "completed" | "partial" | "timed_out";

/** Status for a background-task progress event (kind=async runs spawned by the agent). */
export type BackgroundTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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
  // ── Reasoning ("chain of thought") ──────────────────────────────────────
  // Emitted when a reasoning-capable model streams its thinking. A turn may
  // contain several reasoning segments (one per tool-loop step), each keyed by
  // `reasoningId`. `reasoning-start` opens a segment, `reasoning-delta` appends
  // thinking text, `reasoning-end` closes it with the elapsed time.
  | { type: "reasoning-start"; messageId: string; reasoningId: string }
  | { type: "reasoning-delta"; reasoningId: string; text: string }
  | { type: "reasoning-end"; reasoningId: string; durationMs: number }
  // ── Step boundaries ("chain of action") ─────────────────────────────────
  // Multi-step tool-loop markers from the SDK's start-step/finish-step parts.
  // Surfaced so the timeline can render think→act→observe as discrete steps.
  | { type: "step-start"; messageId: string; stepIndex: number }
  | { type: "step-finish"; stepIndex: number }
  // ── Streaming tool arguments ────────────────────────────────────────────
  // Emitted before `tool-call-start` while the model is still composing the
  // tool's arguments. `tool-input-start` creates a "pending" tool-call entry;
  // `tool-input-delta` appends the partial argument JSON as it is typed. The
  // subsequent `tool-call-start` replaces the partial with the parsed input and
  // flips the entry to "running".
  | {
      type: "tool-input-start";
      messageId: string;
      toolCallId: string;
      capability: string;
    }
  | { type: "tool-input-delta"; toolCallId: string; delta: string }
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
  // ── External-MCP first-use consent (OXA-816) ────────────────────────────
  // Emitted the first time the agent invokes an external MCP tool the user
  // has not yet consented to. The client renders a ConsentCard; the user's
  // approve/deny resolves it via agent.mcp.consent.resolve, which resumes the
  // paused stream. `consent-resolved` mirrors `approval-resolved`.
  | {
      type: "consent-required";
      approvalId: string;
      capability: string;
      serverId: string;
      toolName: string;
      inputPreview: unknown;
      expiresAt: string;
    }
  | {
      type: "consent-resolved";
      approvalId: string;
      resolution: ConsentResolution;
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
  // ── Background tasks ─────────────────────────────────────────────────────
  // Emitted when the agent dispatches a long-running Inngest job
  // (agent.task.background.start) and as it transitions states. The chat UI
  // renders a progress indicator linked to the background-task tray.
  | {
      type: "background-task-progress";
      taskId: string;
      kind: string;
      label?: string;
      status: BackgroundTaskStatus;
      inngestRunId?: string;
      progressPct?: number;
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

/**
 * A persisted reasoning ("chain of thought") segment — the terminal form of a
 * reasoning-start→delta*→end stream sequence. Rendered by the ReasoningCard as
 * a collapsed "Thought for {duration}" disclosure that re-expands on click.
 */
export interface ReasoningContentBlock {
  type: "reasoning";
  reasoningId: string;
  text: string;
  durationMs?: number;
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

/**
 * A persisted external-MCP consent request block (OXA-816) — the terminal form
 * of a consent-required → consent-resolved stream sequence. Rendered by the
 * ConsentCard as a grant/deny prompt for a first-use external tool.
 */
export interface ConsentRequestContentBlock {
  type: "consent-request";
  approvalId: string;
  capability: string;
  serverId: string;
  toolName: string;
  inputPreview: unknown;
  expiresAt: string;
  resolution?: ConsentResolution;
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

/** Persisted background-task block (terminal). */
export interface BackgroundTaskContentBlock {
  type: "background-task";
  taskId: string;
  kind: string;
  label?: string;
  status: BackgroundTaskStatus;
  inngestRunId?: string;
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
  | ReasoningContentBlock
  | ToolCallContentBlock
  | CodeExecuteContentBlock
  | ApprovalRequestContentBlock
  | ConsentRequestContentBlock
  | PlanContentBlock
  | SubagentFanoutContentBlock
  | MemoryRecallContentBlock
  | BackgroundTaskContentBlock
  | ComponentContentBlock;
