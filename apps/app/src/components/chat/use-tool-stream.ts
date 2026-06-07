"use client";
import * as React from "react";
import type {
  ApprovalResolution,
  MemoryRecallHit,
  MemoryWeight,
  PlanDecision,
  PlanStep,
  RiskLevel,
  StreamEvent,
  SubagentChild,
  SubagentStatus,
  ToolCallStatus,
  TurnUsage,
} from "./stream-event-types";

export interface LiveAssistantMessage {
  messageId: string;
  text: string;
}

export interface LiveToolCall {
  toolCallId: string;
  messageId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  status: ToolCallStatus;
  stdout: string;
  stderr: string;
  output?: unknown;
  errorReason?: string;
  durationMs?: number;
  startedAt: number;
  /**
   * Partial argument JSON accumulated from tool-input-delta events while the
   * model is still composing the call (status === "pending"). Cleared/ignored
   * once the parsed `inputPreview` lands with tool-call-start.
   */
  partialInput?: string;
}

/**
 * A live reasoning ("chain of thought") segment accumulated from
 * reasoning-start → reasoning-delta* → reasoning-end. Keyed by reasoningId in
 * `ToolStreamState.reasonings`.
 */
export interface LiveReasoning {
  reasoningId: string;
  messageId: string;
  text: string;
  status: "thinking" | "done";
  startedAt: number;
  durationMs?: number;
}

/**
 * A live multi-step boundary from start-step/finish-step. Keyed by stepIndex.
 * Surfaced as subtle step markers in the activity timeline (only shown when a
 * turn has more than one step).
 */
export interface LiveStep {
  stepIndex: number;
  status: "running" | "done";
}

/**
 * An interleaved assistant-text segment. The model emits text in bursts that
 * interleave with tool calls and reasoning; each contiguous run of text between
 * non-text events becomes its own segment so the timeline preserves true
 * think→act→speak order (rather than collapsing all text into one node).
 */
export interface LiveTextSegment {
  key: string;
  messageId: string;
  text: string;
}

export interface LivePendingApproval {
  approvalId: string;
  capability: string;
  inputPreview: unknown;
  riskLevel: RiskLevel;
  expiresAt: string;
  resolution?: ApprovalResolution;
}

export interface LivePlan {
  planId: string;
  title: string;
  steps: PlanStep[];
  rationale?: string;
  status: "pending" | PlanDecision;
}

export interface LiveFanout {
  fanoutId: string;
  parentMessageId: string;
  children: SubagentChild[];
  status: SubagentStatus;
  results?: Array<{ childMessageId: string; output: unknown }>;
}

export interface LiveMemoryRecall {
  queryId: string;
  memories: MemoryRecallHit[];
}

/** A committed memory node, surfaced as a confirmation card after write. */
export interface LiveMemoryWrite {
  memoryId: string;
  nodeRef: string;
  weight: MemoryWeight | string;
}

/**
 * A live component directive received from a "component" stream event.
 * Keyed by toolCallId in `ToolStreamState.components`.
 */
export interface LiveComponent {
  toolCallId: string;
  componentId: string;
  props: Record<string, unknown>;
}

export interface ToolStreamState {
  messages: Record<string, LiveAssistantMessage>;
  toolCalls: Record<string, LiveToolCall>;
  /** Reasoning segments received this turn, keyed by reasoningId. */
  reasonings: Record<string, LiveReasoning>;
  /** Multi-step boundaries this turn, keyed by stepIndex. */
  steps: Record<number, LiveStep>;
  /** Interleaved assistant-text segments, keyed by segment key. */
  textSegments: Record<string, LiveTextSegment>;
  pendingApprovals: Record<string, LivePendingApproval>;
  plans: Record<string, LivePlan>;
  activeFanouts: Record<string, LiveFanout>;
  memoryRecalls: Record<string, LiveMemoryRecall>;
  memoryWrites: Record<string, LiveMemoryWrite>;
  /** Live component directives received this turn, keyed by toolCallId. */
  components: Record<string, LiveComponent>;
  /**
   * Ordered list of timeline-entry keys in first-appearance order. Each key is
   * `<kind>:<id>` (e.g. "reasoning:abc", "tool:xyz", "text:msg:3", "step:0").
   * The activity timeline walks this to render the chain in true stream order.
   */
  order: string[];
  /**
   * Internal cursor: the key of the text segment currently being appended to,
   * or null when the next text delta should open a fresh segment. Cleared on
   * every non-text timeline event so text breaks around tools/reasoning.
   */
  activeTextKey: string | null;
  /** Usage summary from the turn's "usage" event; undefined until the event arrives. */
  turnUsage: TurnUsage | undefined;
}

export const INITIAL_STATE: ToolStreamState = {
  messages: {},
  toolCalls: {},
  reasonings: {},
  steps: {},
  textSegments: {},
  pendingApprovals: {},
  plans: {},
  activeFanouts: {},
  memoryRecalls: {},
  memoryWrites: {},
  components: {},
  order: [],
  activeTextKey: null,
  turnUsage: undefined,
};

/** Append a timeline key in first-appearance order (idempotent). */
function withOrder(order: string[], key: string): string[] {
  return order.includes(key) ? order : [...order, key];
}

export type Action = { type: "event"; event: StreamEvent } | { type: "reset" };

export function reducer(state: ToolStreamState, action: Action): ToolStreamState {
  if (action.type === "reset") return INITIAL_STATE;
  const e = action.event;
  switch (e.type) {
    case "text": {
      const prevMsg = state.messages[e.messageId] ?? { messageId: e.messageId, text: "" };
      // Reuse the open segment, or open a fresh one keyed by position so text
      // before/after a tool call renders as distinct timeline nodes.
      const segKey = state.activeTextKey ?? `text:${e.messageId}:${state.order.length}`;
      const prevSeg =
        state.textSegments[segKey] ?? { key: segKey, messageId: e.messageId, text: "" };
      return {
        ...state,
        messages: {
          ...state.messages,
          [e.messageId]: { ...prevMsg, text: prevMsg.text + e.text },
        },
        textSegments: {
          ...state.textSegments,
          [segKey]: { ...prevSeg, text: prevSeg.text + e.text },
        },
        order: withOrder(state.order, segKey),
        activeTextKey: segKey,
      };
    }
    case "reasoning-start": {
      return {
        ...state,
        reasonings: {
          ...state.reasonings,
          [e.reasoningId]: {
            reasoningId: e.reasoningId,
            messageId: e.messageId,
            text: "",
            status: "thinking",
            startedAt: Date.now(),
          },
        },
        order: withOrder(state.order, `reasoning:${e.reasoningId}`),
        activeTextKey: null,
      };
    }
    case "reasoning-delta": {
      const existing =
        state.reasonings[e.reasoningId] ??
        ({
          reasoningId: e.reasoningId,
          messageId: "",
          text: "",
          status: "thinking" as const,
          startedAt: Date.now(),
        } satisfies LiveReasoning);
      return {
        ...state,
        reasonings: {
          ...state.reasonings,
          [e.reasoningId]: { ...existing, text: existing.text + e.text },
        },
        order: withOrder(state.order, `reasoning:${e.reasoningId}`),
        activeTextKey: null,
      };
    }
    case "reasoning-end": {
      const existing = state.reasonings[e.reasoningId];
      if (!existing) return state;
      return {
        ...state,
        reasonings: {
          ...state.reasonings,
          [e.reasoningId]: { ...existing, status: "done", durationMs: e.durationMs },
        },
      };
    }
    case "step-start": {
      return {
        ...state,
        steps: {
          ...state.steps,
          [e.stepIndex]: { stepIndex: e.stepIndex, status: "running" },
        },
        order: withOrder(state.order, `step:${e.stepIndex}`),
        activeTextKey: null,
      };
    }
    case "step-finish": {
      const existing = state.steps[e.stepIndex];
      if (!existing) return state;
      return {
        ...state,
        steps: { ...state.steps, [e.stepIndex]: { ...existing, status: "done" } },
      };
    }
    case "tool-input-start": {
      const existing = state.toolCalls[e.toolCallId];
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]:
            existing ??
            ({
              toolCallId: e.toolCallId,
              messageId: e.messageId,
              capability: e.capability,
              inputPreview: undefined,
              riskLevel: "low",
              status: "pending",
              stdout: "",
              stderr: "",
              partialInput: "",
              startedAt: Date.now(),
            } satisfies LiveToolCall),
        },
        order: withOrder(state.order, `tool:${e.toolCallId}`),
        activeTextKey: null,
      };
    }
    case "tool-input-delta": {
      const existing = state.toolCalls[e.toolCallId];
      if (!existing) return state;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]: {
            ...existing,
            partialInput: (existing.partialInput ?? "") + e.delta,
          },
        },
      };
    }
    case "tool-call-start": {
      const existing = state.toolCalls[e.toolCallId];
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]: {
            toolCallId: e.toolCallId,
            messageId: e.messageId,
            capability: e.capability,
            inputPreview: e.inputPreview,
            riskLevel: e.riskLevel,
            status: "running",
            stdout: existing?.stdout ?? "",
            stderr: existing?.stderr ?? "",
            output: existing?.output,
            errorReason: existing?.errorReason,
            durationMs: existing?.durationMs,
            startedAt: existing?.startedAt ?? Date.now(),
            partialInput: existing?.partialInput,
          },
        },
        order: withOrder(state.order, `tool:${e.toolCallId}`),
        activeTextKey: null,
      };
    }
    case "tool-call-output": {
      const existing = state.toolCalls[e.toolCallId];
      if (!existing) return state;
      const key = e.chunk.channel;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]: { ...existing, [key]: existing[key] + e.chunk.data },
        },
      };
    }
    case "tool-call-end": {
      const existing = state.toolCalls[e.toolCallId];
      if (!existing) return state;
      return {
        ...state,
        toolCalls: {
          ...state.toolCalls,
          [e.toolCallId]: {
            ...existing,
            status: e.status,
            output: e.output,
            errorReason: e.errorReason,
            durationMs: e.durationMs,
          },
        },
      };
    }
    case "approval-required": {
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [e.approvalId]: {
            approvalId: e.approvalId,
            capability: e.capability,
            inputPreview: e.inputPreview,
            riskLevel: e.riskLevel,
            expiresAt: e.expiresAt,
          },
        },
        order: withOrder(state.order, `approval:${e.approvalId}`),
        activeTextKey: null,
      };
    }
    case "approval-resolved": {
      const existing = state.pendingApprovals[e.approvalId];
      if (!existing) return state;
      return {
        ...state,
        pendingApprovals: {
          ...state.pendingApprovals,
          [e.approvalId]: { ...existing, resolution: e.resolution },
        },
      };
    }
    case "plan-proposed": {
      return {
        ...state,
        plans: {
          ...state.plans,
          [e.planId]: {
            planId: e.planId,
            title: e.title,
            steps: e.steps,
            rationale: e.rationale,
            status: "pending",
          },
        },
        order: withOrder(state.order, `plan:${e.planId}`),
        activeTextKey: null,
      };
    }
    case "plan-resolved": {
      const existing = state.plans[e.planId];
      if (!existing) return state;
      return {
        ...state,
        plans: { ...state.plans, [e.planId]: { ...existing, status: e.decision } },
      };
    }
    case "subagent-dispatched": {
      return {
        ...state,
        activeFanouts: {
          ...state.activeFanouts,
          [e.fanoutId]: {
            fanoutId: e.fanoutId,
            parentMessageId: e.parentMessageId,
            children: e.children.map((c) => ({ ...c, status: "running" as SubagentStatus })),
            status: "running",
          },
        },
        order: withOrder(state.order, `fanout:${e.fanoutId}`),
        activeTextKey: null,
      };
    }
    case "subagent-completed": {
      const existing = state.activeFanouts[e.fanoutId];
      if (!existing) return state;
      return {
        ...state,
        activeFanouts: {
          ...state.activeFanouts,
          [e.fanoutId]: { ...existing, status: e.status, results: e.results },
        },
      };
    }
    case "memory-recalled": {
      return {
        ...state,
        memoryRecalls: {
          ...state.memoryRecalls,
          [e.queryId]: { queryId: e.queryId, memories: e.memories },
        },
        order: withOrder(state.order, `memory:${e.queryId}`),
        activeTextKey: null,
      };
    }
    case "memory-written": {
      // Track the committed memory node so a confirmation card renders inline.
      return {
        ...state,
        memoryWrites: {
          ...state.memoryWrites,
          [e.memoryId]: {
            memoryId: e.memoryId,
            nodeRef: e.nodeRef,
            weight: e.weight,
          },
        },
        order: withOrder(state.order, `memwrite:${e.memoryId}`),
        activeTextKey: null,
      };
    }
    case "component": {
      return {
        ...state,
        components: {
          ...state.components,
          [e.toolCallId]: {
            toolCallId: e.toolCallId,
            componentId: e.componentId,
            props: e.props,
          },
        },
        order: withOrder(state.order, `component:${e.toolCallId}`),
        activeTextKey: null,
      };
    }
    case "usage": {
      return { ...state, turnUsage: e.usage };
    }
    default:
      return state;
  }
}

// A pending-approval waiter is a Promise that resolves when the approval
// with the given approvalId gets a resolution. The consumer calls
// `registerWaiter(approvalId)` before dispatching `approval-required`, then
// awaits the returned Promise before processing subsequent events.
// `signalResolved(approvalId)` is called by `ChatShellClient` when the user
// (or an incoming `approval-resolved` stream event) settles the approval.
interface ApprovalWaiter {
  promise: Promise<void>;
  resolve: () => void;
}

export interface UseToolStreamResult extends ToolStreamState {
  consume: (stream: ReadableStream<StreamEvent> | AsyncIterable<StreamEvent>) => Promise<void>;
  reset: () => void;
  hasBlockingApproval: boolean;
  /** Signal that a pending approval has been resolved (by user action or
   *  incoming stream event). Unblocks the `consume` loop so the stream
   *  continues processing subsequent events. */
  signalApprovalResolved: (approvalId: string) => void;
  /** Token + credit usage for the completed turn. Undefined until the
   *  "usage" event arrives (just before [DONE]). */
  turnUsage: TurnUsage | undefined;
}

export function useToolStream(): UseToolStreamResult {
  const [state, dispatch] = React.useReducer(reducer, INITIAL_STATE);

  // Map from approvalId → waiter. Populated when `approval-required` is
  // dispatched, resolved when the UI or stream signals completion.
  const approvalWaiters = React.useRef<Map<string, ApprovalWaiter>>(new Map());

  const signalApprovalResolved = React.useCallback((approvalId: string) => {
    const waiter = approvalWaiters.current.get(approvalId);
    if (waiter) {
      waiter.resolve();
      approvalWaiters.current.delete(approvalId);
    }
  }, []);

  const consume = React.useCallback(
    async (stream: ReadableStream<StreamEvent> | AsyncIterable<StreamEvent>) => {
      const iter: AsyncIterable<StreamEvent> = isReadable(stream)
        ? readableToAsyncIterable(stream)
        : stream;
      for await (const event of iter) {
        // If the stream itself carries an `approval-resolved` event, signal
        // the waiter BEFORE dispatching so the loop doesn't deadlock. The
        // dispatch below then updates the UI to show the resolved state.
        if (event.type === "approval-resolved") {
          signalApprovalResolved(event.approvalId);
        }

        dispatch({ type: "event", event });

        // For `approval-required` events, pause the consume loop until the
        // approval is resolved (either by the user clicking Approve/Deny or
        // by a subsequent `approval-resolved` event from the stream). This
        // ensures intermediate UI states (disabled composer, visible approval
        // card) are observable before the stream continues — critical for
        // correct UX and for the Playwright e2e assertions.
        if (event.type === "approval-required") {
          let resolveWaiter!: () => void;
          const promise = new Promise<void>((r) => {
            resolveWaiter = r;
          });
          const waiter: ApprovalWaiter = { promise, resolve: resolveWaiter };
          approvalWaiters.current.set(event.approvalId, waiter);
          // Use a macrotask boundary so React has time to flush the
          // approval-required dispatch above and actually render the
          // approval card + disabled composer before we process more events.
          await new Promise<void>((r) => setTimeout(r, 0));
          await waiter.promise;
        }
      }
    },
    [signalApprovalResolved],
  );

  const reset = React.useCallback(() => {
    // Resolve all pending waiters so any in-flight consume loop unblocks
    // and exits cleanly on reset.
    for (const w of approvalWaiters.current.values()) w.resolve();
    approvalWaiters.current.clear();
    dispatch({ type: "reset" });
  }, []);

  const hasBlockingApproval = React.useMemo(
    () =>
      Object.values(state.pendingApprovals).some(
        (a) => a.resolution === undefined,
      ),
    [state.pendingApprovals],
  );

  return { ...state, consume, reset, hasBlockingApproval, signalApprovalResolved };
}

function isReadable<T>(
  s: ReadableStream<T> | AsyncIterable<T>,
): s is ReadableStream<T> {
  return typeof (s as ReadableStream<T>).getReader === "function";
}

async function* readableToAsyncIterable<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value !== undefined) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
