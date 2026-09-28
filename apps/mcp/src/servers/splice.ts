// splice.ts: the served tools inside Oxagen's own MCP answers (lane M15).
//
// Oxagen's tools answer through xmcp's stateless Streamable HTTP transport,
// which frames each JSON-RPC message as a server-sent event, or as a JSON
// body when the transport answers in JSON. The gateway adds the served tools
// to the tools/list answer after the transport writes it, and answers a
// served tools/call itself in the same framing. Nothing here opens an SSE
// stream of its own (#4556).
import type { CallToolResult, EffectiveDefinition } from "@oxagen/mcp-studio";

export type RpcId = string | number;

/** One JSON-RPC request, as the gateway reads it before the transport does. */
export interface RpcRequest {
  id: RpcId;
  method: string;
  params: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The request a POST body carries, or null for a batch, a notification, or
 * anything else the gateway leaves to the transport.
 */
export function rpcRequest(body: unknown): RpcRequest | null {
  if (!isRecord(body)) return null;
  const { id, method, params } = body;
  if (typeof id !== "string" && typeof id !== "number") return null;
  if (typeof method !== "string") return null;
  if (params !== undefined && !isRecord(params)) return null;
  return { id, method, params: params ?? {} };
}

/** The served tools after Oxagen's own, leaving out any name Oxagen already lists. */
function withServed(message: unknown, id: RpcId, served: readonly EffectiveDefinition[]): unknown {
  if (!isRecord(message) || message["id"] !== id) return message;
  const result = message["result"];
  if (!isRecord(result) || !Array.isArray(result["tools"])) return message;
  const own = result["tools"] as unknown[];
  const names = new Set(own.map((tool) => (isRecord(tool) ? tool["name"] : undefined)));
  const added = served.filter((tool) => !names.has(tool.name));
  return { ...message, result: { ...result, tools: [...own, ...added] } };
}

function spliceEvent(event: string, id: RpcId, served: readonly EffectiveDefinition[]): string {
  const lines = event.split(/\r?\n/);
  const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
  if (data.length === 0) return event;
  let message: unknown;
  try {
    message = JSON.parse(data.join("\n"));
  } catch {
    return event;
  }
  const spliced = withServed(message, id, served);
  if (spliced === message) return event;
  const kept = lines.filter((line) => !line.startsWith("data:"));
  return [...kept, `data: ${JSON.stringify(spliced)}`].join("\n");
}

/**
 * The tools/list answer with the served tools added to the result whose id
 * is the request's. A body the gateway cannot read passes through unchanged.
 */
export function spliceTools(body: string, contentType: string | undefined, id: RpcId, served: readonly EffectiveDefinition[]): string {
  if (served.length === 0) return body;
  if ((contentType ?? "").includes("text/event-stream")) {
    return body
      .split(/(\r?\n\r?\n)/)
      .map((part) => (/^\r?\n\r?\n$/.test(part) ? part : spliceEvent(part, id, served)))
      .join("");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  const spliced = Array.isArray(parsed) ? parsed.map((message) => withServed(message, id, served)) : withServed(parsed, id, served);
  return spliced === parsed ? body : JSON.stringify(spliced);
}

/** A framed answer to one request. */
export interface FramedReply {
  contentType: string;
  body: string;
}

/** A served tools/call's answer, as a server-sent event when the client accepts one, else as JSON. */
export function frameReply(id: RpcId, result: CallToolResult, accept: string | undefined): FramedReply {
  const message = JSON.stringify({ jsonrpc: "2.0", id, result });
  if ((accept ?? "").includes("text/event-stream")) {
    return { contentType: "text/event-stream", body: `event: message\ndata: ${message}\n\n` };
  }
  return { contentType: "application/json", body: message };
}
