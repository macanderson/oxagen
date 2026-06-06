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
  pendingApprovals: Record<string, LivePendingApproval>;
  plans: Record<string, LivePlan>;
  activeFanouts: Record<string, LiveFanout>;
  memoryRecalls: Record<string, LiveMemoryRecall>;
  memoryWrites: Record<string, LiveMemoryWrite>;
  /** Live component directives received this turn, keyed by toolCallId. */
  components: Record<string, LiveComponent>;
  /** Usage summary from the turn's "usage" event; undefined until the event arrives. */
  turnUsage: TurnUsage | undefined;
}

export const INITIAL_STATE: ToolStreamState = {
  messages: {},
  toolCalls: {},
  pendingApprovals: {},
  plans: {},
  activeFanouts: {},
  memoryRecalls: {},
  memoryWrites: {},
  components: {},
  turnUsage: undefined,
};

export type Action = { type: "event"; event: StreamEvent } | { type: "reset" };

export function reducer(state: ToolStreamState, action: Action): ToolStreamState {
  if (action.type === "reset") return INITIAL_STATE;
  const e = action.event;
  switch (e.type) {
    case "text": {
      const prev = state.messages[e.messageId] ?? { messageId: e.messageId, text: "" };
      return {
        ...state,
        messages: {
          ...state.messages,
          [e.messageId]: { ...prev, text: prev.text + e.text },
        },
      };
    }
    case "tool-call-start": {
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
            stdout: "",
            stderr: "",
            startedAt: Date.now(),
          },
        },
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
