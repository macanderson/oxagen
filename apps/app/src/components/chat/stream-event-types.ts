// Typed shapes for the interleaved chat stream chunks emitted by the agent
// runtime. Each event is rendered inline against the assistant message
// identified by `messageId` / `toolCallId` / `approvalId` / `planId` /
// `fanoutId`. The producer side lives in
// apps/app/src/app/api/v1/chat/stream/translate-stream.ts.

// Reuse the background-task status union defined by the tray so the inline
// streaming card and the tray never drift (queued|running|completed|failed|cancelled).
import type { BackgroundTaskStatus } from "./background-task-types";
import type { KnowledgeNodeRef } from "@oxagen/oxagen/contracts/knowledge.node-ref";
export type { BackgroundTaskStatus };
export type { KnowledgeNodeRef };

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
  /** Prompt-cache read tokens — the subset of `promptTokens` served from the
   * provider's prompt cache. Drives the per-turn cache-hit visualization so the
   * user can instrument cache drift. Absent/0 when the turn had no cache hits. */
  cachedTokens?: number;
  /** Cost in credits (1 credit = 1¢ USD). Present when billing is wired. */
  creditsCharged?: number;
}

/**
 * Per-assistant-message run receipt (chat_ux_v2), persisted into
 * `messages.metadata.receipt` when the turn completes — so history renders
 * the same `{model} · {effort} · {$cost}` line the live turn showed, from the
 * same numbers the usage event carried.
 */
export interface MessageReceipt {
  /** Resolved gateway model id the turn ran on. */
  model: string;
  /** Reasoning effort the turn ran with, when applicable. */
  effort: "low" | "medium" | "high" | null;
  /** Wall-clock turn duration, request start → persistence. */
  durationMs: number;
  usage: TurnUsage;
}

/** Tolerant parse of `messages.metadata.receipt`. Null on any wrong shape. */
export function parseMessageReceipt(raw: unknown): MessageReceipt | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.model !== "string" || typeof obj.durationMs !== "number") {
    return null;
  }
  const usage =
    typeof obj.usage === "object" && obj.usage !== null
      ? (obj.usage as Record<string, unknown>)
      : null;
  if (!usage) return null;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  return {
    model: obj.model,
    effort:
      obj.effort === "low" || obj.effort === "medium" || obj.effort === "high"
        ? obj.effort
        : null,
    durationMs: obj.durationMs,
    usage: {
      promptTokens: num(usage.promptTokens),
      completionTokens: num(usage.completionTokens),
      totalTokens: num(usage.totalTokens),
      ...(typeof usage.cachedTokens === "number"
        ? { cachedTokens: usage.cachedTokens }
        : {}),
      ...(typeof usage.creditsCharged === "number"
        ? { creditsCharged: usage.creditsCharged }
        : {}),
    },
  };
}

// "pending" is the pre-execution phase while the model is still streaming the
// tool's arguments (tool-input-start → tool-input-delta*); it flips to
// "running" once the full tool-call lands and execution begins. Persisted
// blocks are always terminal ("completed" | "failed"); "pending"/"running"
// only exist on live (in-flight) tool calls.
export type ToolCallStatus = "pending" | "running" | "completed" | "failed";

export type ApprovalResolution = "approved" | "denied" | "expired";

// External-MCP consent resolution. Distinct vocabulary from
// ApprovalResolution: a consent grant is "granted"/"denied" (not "approved").
export type ConsentResolution = "granted" | "denied" | "expired";

export type PlanDecision = "approved" | "denied" | "amended";

/** Mirrors TurnBudgetMode in @oxagen/billing (kept as a literal string union
 * here — this module is imported by client code, so it stays dependency-light
 * rather than importing the value-heavy @oxagen/billing barrel; see
 * budget-control.tsx for the same rationale). */
export type TurnBudgetModeName = "grace" | "prompt" | "enforce";

/** The two non-blocking budget states a turn can report inline: "stopped" —
 * the turn ended because the ceiling was crossed (enforce mode, or a grace
 * cushion exhausted); "within_grace" — the turn is running past its base
 * limit but still inside the grace cushion (grace mode only). The gated
 * "prompt" mode pause reuses the existing approval-required/-resolved events
 * instead of a bespoke one — it needs a blocking round-trip, which those
 * events (and the client's approval-waiter machinery) already provide. */
export type TurnBudgetNoticeState = "stopped" | "within_grace";

export type SubagentStatus = "running" | "completed" | "partial" | "timed_out";

/** Epistemic status on the confidence ladder (agent.memory.model#memoryClassEnum). */
export type MemoryClass = "OBSERVATION" | "RULE" | "FACT";

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
  /** Epistemic class: OBSERVATION → RULE → FACT. */
  memoryClass: MemoryClass | string;
  /** Content-domain kind (open string, e.g. "constraint", "gotcha"). */
  memoryKind: string;
  /** 0-100 evidence measure; auto-decays. */
  confidenceScore: number;
  /** 1-100 for RULE, 100 for FACT, null for OBSERVATION. */
  enforcementScore: number | null;
  score: number;
  nodeRef?: string;
  /**
   * The knowledge-graph node this memory is grounded in, resolved server-side to
   * the shared `KnowledgeNodeRef` shape ({ id, label, displayName, properties }).
   * Present when the memory's `nodeRef` (its subject publicId) resolves to a real
   * node in the workspace graph, so the chat UI can cite the fact by its human
   * label via `NodeRef` and deep-link to it in the graph explorer — never a bare
   * UUID. Absent for memories whose subject is not (yet) materialised as a node.
   */
  node?: KnowledgeNodeRef;
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
  // ── External-MCP first-use consent ────────────────────────────
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
      children: Array<{
        childMessageId: string;
        capability: string;
        label?: string;
      }>;
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
      memoryClass: MemoryClass | string;
      enforcementScore: number | null;
    }
  | {
      /**
       * Emitted when the agent starts or advances a long-running background
       * task via agent.task.background.start. Drives the inline
       * BackgroundTaskCard and links to the BackgroundTaskTray.
       */
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
    }
  | {
      /**
       * Emitted once per turn, near the [DONE] sentinel, with 3 conversation-
       * aware "next step" suggestion chips generated by a fast model (see
       * ./stream/suggest-prompts.ts). Purely ephemeral UX — NOT persisted to
       * `content_blocks` (so there is no matching ContentBlock type) — the
       * client shows them until the next turn starts, then clears them. Absent
       * when generation failed or timed out; the client falls back to the
       * static page-context heuristics in that case.
       */
      type: "suggested-prompts";
      suggestions: Array<{ label: string; prompt: string }>;
    }
  | {
      /**
       * Per-turn dollar budget (OXA — turn-budget): a non-blocking notice from
       * the engine's budgetGuard, emitted by its onStop/onWithinGrace hooks in
       * the stream route. "stopped" ends the turn early (mirrors the engine's
       * `stopReason: "budget"`); "within_grace" is an informational notice
       * that keeps streaming. The gated "prompt" mode's pause-for-approval is
       * NOT this event — it reuses approval-required/-resolved instead (see
       * TurnBudgetNoticeState).
       */
      type: "budget-notice";
      state: TurnBudgetNoticeState;
      costUsd: number;
      limitUsd: number;
      mode: TurnBudgetModeName;
    }
  | {
      /**
       * Live cumulative cost while a BUDGETED turn streams (chat_ux_v2):
       * emitted per engine step from the budget guard's onTick hook, powering
       * the "≈ $0.31" estimate near the in-progress message. Unbudgeted turns
       * never emit it. Distinct from budget-notice, which carries the
       * blocking/toast-worthy states.
       */
      type: "budget-tick";
      costUsd: number;
      limitUsd: number;
    }
  | {
      /**
       * A NON-fatal advisory — the turn itself SUCCEEDED. Emitted e.g. when
       * persisting the assistant reply to history failed, so the user knows this
       * turn may be missing after a refresh. Surfaced as a toast like `error`,
       * but it never marks the turn failed and is never folded into text.
       */
      type: "warning";
      message: string;
      code?: string;
    }
  | {
      /**
       * A turn-level failure — a provider/gateway error, a billing block
       * (e.g. insufficient_credits), or an unexpected server throw. Carries a
       * human-readable `message` (and optional machine `code`) already parsed
       * out of the error envelope, so the client surfaces it as a TOAST. It is
       * NEVER folded into assistant text: that would render a raw JSON envelope
       * inline on the page and poison the next turn's history context.
       */
      type: "error";
      messageId: string;
      message: string;
      code?: string;
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
 * A persisted external-MCP consent request block — the terminal form
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

/**
 * A persisted background-task block — the terminal form of a
 * "background-task-progress" event written to `chat.messages.content_blocks`.
 */
export interface BackgroundTaskContentBlock {
  type: "background-task";
  taskId: string;
  kind: string;
  label?: string;
  status: BackgroundTaskStatus;
  inngestRunId?: string;
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
