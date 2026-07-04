/**
 * A2A (Agent2Agent) protocol v1.0 — wire types for the JSON-RPC transport.
 *
 * These are the concrete JSON-RPC binding shapes an A2A client sends/receives
 * on the wire (lowercase task states, `kind` discriminators, slash-delimited
 * method names) — NOT the abstract gRPC/proto Layer-2 representation. The Agent
 * Card shape lives in the a2a.card.get contract (@oxagen/oxagen); everything
 * task/message/event-related lives here because it is used only by the apps/api
 * transport (bridge, rpc dispatcher, task store).
 *
 * Spec: https://a2a-protocol.org/ — JSON-RPC binding, protocolVersion "1.0".
 */
import { z } from "zod";

// ── Task lifecycle states (A2A lowercase wire strings) ────────────────────────
export const A2A_TASK_STATES = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "canceled",
  "failed",
  "rejected",
  "unknown",
] as const;
export const a2aTaskState = z.enum(A2A_TASK_STATES);
export type A2ATaskState = z.output<typeof a2aTaskState>;

/** Terminal states — the stream closes and the task is immutable afterwards. */
export const A2A_TERMINAL_STATES: ReadonlySet<A2ATaskState> = new Set([
  "completed",
  "canceled",
  "failed",
  "rejected",
]);

// ── Parts (content units) ─────────────────────────────────────────────────────
export const a2aTextPart = z.object({
  kind: z.literal("text"),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const a2aFilePart = z.object({
  kind: z.literal("file"),
  file: z.union([
    z.object({
      name: z.string().optional(),
      mimeType: z.string().optional(),
      bytes: z.string(), // base64
    }),
    z.object({
      name: z.string().optional(),
      mimeType: z.string().optional(),
      uri: z.string(),
    }),
  ]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const a2aDataPart = z.object({
  kind: z.literal("data"),
  data: z.record(z.string(), z.unknown()),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const a2aPart = z.discriminatedUnion("kind", [
  a2aTextPart,
  a2aFilePart,
  a2aDataPart,
]);
export type A2APart = z.output<typeof a2aPart>;

// ── Message ───────────────────────────────────────────────────────────────────
export const a2aMessage = z.object({
  kind: z.literal("message").default("message"),
  role: z.enum(["user", "agent"]),
  parts: z.array(a2aPart).min(1),
  messageId: z.string(),
  taskId: z.string().optional(),
  contextId: z.string().optional(),
  referenceTaskIds: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2AMessage = z.output<typeof a2aMessage>;

// ── Artifact ────────────────────────────────────────────────────────────────
export const a2aArtifact = z.object({
  artifactId: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(a2aPart),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2AArtifact = z.output<typeof a2aArtifact>;

// ── Task + status ─────────────────────────────────────────────────────────────
export const a2aTaskStatus = z.object({
  state: a2aTaskState,
  message: a2aMessage.optional(),
  timestamp: z.string().optional(),
});
export type A2ATaskStatus = z.output<typeof a2aTaskStatus>;

export const a2aTask = z.object({
  kind: z.literal("task").default("task"),
  id: z.string(),
  contextId: z.string(),
  status: a2aTaskStatus,
  artifacts: z.array(a2aArtifact).optional(),
  history: z.array(a2aMessage).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2ATask = z.output<typeof a2aTask>;

// ── Streaming events (SSE payloads for message/stream & tasks/resubscribe) ─────
export const a2aStatusUpdateEvent = z.object({
  kind: z.literal("status-update"),
  taskId: z.string(),
  contextId: z.string(),
  status: a2aTaskStatus,
  final: z.boolean(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2AStatusUpdateEvent = z.output<typeof a2aStatusUpdateEvent>;

export const a2aArtifactUpdateEvent = z.object({
  kind: z.literal("artifact-update"),
  taskId: z.string(),
  contextId: z.string(),
  artifact: a2aArtifact,
  append: z.boolean().optional(),
  lastChunk: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2AArtifactUpdateEvent = z.output<typeof a2aArtifactUpdateEvent>;

// ── message/send params ───────────────────────────────────────────────────────
export const a2aMessageSendParams = z.object({
  message: a2aMessage,
  configuration: z
    .object({
      blocking: z.boolean().optional(),
      historyLength: z.number().int().nonnegative().optional(),
      acceptedOutputModes: z.array(z.string()).optional(),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type A2AMessageSendParams = z.output<typeof a2aMessageSendParams>;

export const a2aTaskIdParams = z.object({
  id: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const a2aTaskQueryParams = z.object({
  id: z.string(),
  historyLength: z.number().int().nonnegative().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ── JSON-RPC 2.0 envelope ─────────────────────────────────────────────────────
export const jsonRpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type JsonRpcRequest = z.output<typeof jsonRpcRequest>;

/**
 * JSON-RPC error codes. -32700..-32600 are the standard set; the A2A spec
 * reserves -32001..-32006 for protocol-specific errors.
 */
export const A2A_ERROR = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotificationNotSupported: -32003,
  unsupportedOperation: -32004,
  contentTypeNotSupported: -32005,
  invalidAgentResponse: -32006,
} as const;

export type JsonRpcId = string | number | null;

export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id, result };
}

export function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  };
}

/** A2A JSON-RPC method names (concrete slash-delimited binding). */
export const A2A_METHODS = {
  messageSend: "message/send",
  messageStream: "message/stream",
  tasksGet: "tasks/get",
  tasksCancel: "tasks/cancel",
  tasksResubscribe: "tasks/resubscribe",
  authExtendedCard: "agent/getAuthenticatedExtendedCard",
} as const;
