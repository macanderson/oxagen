"use client";
import * as React from "react";
import type {
  ApprovalResolution,
  MemoryRecallHit,
  PlanDecision,
  PlanStep,
  RiskLevel,
  StreamEvent,
  SubagentChild,
  SubagentStatus,
  ToolCallStatus,
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

export interface ToolStreamState {
  messages: Record<string, LiveAssistantMessage>;
  toolCalls: Record<string, LiveToolCall>;
  pendingApprovals: Record<string, LivePendingApproval>;
  plans: Record<string, LivePlan>;
  activeFanouts: Record<string, LiveFanout>;
  memoryRecalls: Record<string, LiveMemoryRecall>;
}

const INITIAL_STATE: ToolStreamState = {
  messages: {},
  toolCalls: {},
  pendingApprovals: {},
  plans: {},
  activeFanouts: {},
  memoryRecalls: {},
};

type Action = { type: "event"; event: StreamEvent } | { type: "reset" };

function reducer(state: ToolStreamState, action: Action): ToolStreamState {
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
    case "memory-written":
      // Surfaced via toast / activity log elsewhere; not part of the live
      // chat state we render inline.
      return state;
    default:
      return state;
  }
}

export interface UseToolStreamResult extends ToolStreamState {
  consume: (stream: ReadableStream<StreamEvent> | AsyncIterable<StreamEvent>) => Promise<void>;
  reset: () => void;
  hasBlockingApproval: boolean;
}

export function useToolStream(): UseToolStreamResult {
  const [state, dispatch] = React.useReducer(reducer, INITIAL_STATE);

  const consume = React.useCallback(
    async (stream: ReadableStream<StreamEvent> | AsyncIterable<StreamEvent>) => {
      const iter: AsyncIterable<StreamEvent> = isReadable(stream)
        ? readableToAsyncIterable(stream)
        : stream;
      for await (const event of iter) {
        dispatch({ type: "event", event });
      }
    },
    [],
  );

  const reset = React.useCallback(() => dispatch({ type: "reset" }), []);

  const hasBlockingApproval = React.useMemo(
    () =>
      Object.values(state.pendingApprovals).some(
        (a) => a.resolution === undefined,
      ),
    [state.pendingApprovals],
  );

  return { ...state, consume, reset, hasBlockingApproval };
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
