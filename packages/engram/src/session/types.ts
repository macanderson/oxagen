/**
 * Event-sourced session types.
 *
 * Every agent interaction is recorded as an append-only event log.
 * Sessions support fork (branch from any point) and replay (deterministic re-execution).
 */
import type { RecordKind, Namespace } from "../types";
import type { TaskFrame } from "../retrieval/types";

export type SessionEventType =
  | "session_start"
  | "turn_start"
  | "context_compiled"
  | "model_request"
  | "model_response"
  | "tool_call"
  | "tool_result"
  | "memory_write"
  | "turn_end"
  | "session_end";

export interface SessionEvent {
  /** Auto-incrementing index within the session. */
  index: number;
  /** Event type discriminant. */
  type: SessionEventType;
  /** Turn ID this event belongs to (null for session-level events). */
  turnId: string | null;
  /** Event payload — shape depends on type. */
  data: unknown;
  /** Unix ms timestamp. */
  timestamp: number;
}

export interface TurnStartData {
  taskFrame: TaskFrame;
}

export interface ContextCompiledData {
  candidatesRetrieved: number;
  candidatesPacked: number;
  candidatesEvicted: number;
  totalTokens: number;
  cacheHitRate: number;
  compileMs: number;
}

export interface ModelRequestData {
  model: string;
  inputTokens: number;
}

export interface ModelResponseData {
  outputTokens: number;
  finishReason: string;
}

export interface ToolCallData {
  tool: string;
  input: unknown;
}

export interface ToolResultData {
  tool: string;
  success: boolean;
  outputTokens: number;
}

export interface MemoryWriteData {
  recordId: string;
  kind: RecordKind;
}

export interface TurnEndData {
  outcome: "success" | "failure" | "interrupted";
  totalTokens: number;
  durationMs: number;
}

export interface Session {
  id: string;
  namespace: Namespace;
  /** If forked, points to parent session ID. */
  parentId?: string;
  /** Event index in parent where this session forked. */
  forkPoint?: number;
  /** Append-only event log. */
  events: SessionEvent[];
  /** Session creation timestamp. */
  createdAt: number;
  /** Current status. */
  status: "active" | "completed" | "forked";
}
