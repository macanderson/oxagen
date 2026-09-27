// fake-http.ts: a Transport that answers HTTP requests from a script, and a
// SendContext around it, for the HTTP, GraphQL, and MCP Senders' tests.
import { vi } from "vitest";
import type { ManifestAuth, ManifestServer, ManifestShaping } from "../../contract/manifest";
import { decodeText, encodeText } from "../body";
import { isRecord } from "../util";
import type { SendContext, SendCredential } from "../sender";
import type {
  CallToolResult,
  HeaderEntry,
  HttpTransportRequest,
  HttpTransportResponse,
  LocalCall,
  Transport,
} from "../transport";

export interface FakeHttp {
  transport: Transport;
  requests: HttpTransportRequest[];
  locals: LocalCall[];
}

/** A Transport whose http() runs `answer` for each request and records it. */
export function fakeHttp(
  answer: (request: HttpTransportRequest, number: number) => Promise<HttpTransportResponse> | HttpTransportResponse,
  local: (call: LocalCall, number: number) => Promise<CallToolResult> = () =>
    Promise.reject(new Error("The test Transport has no local server.")),
): FakeHttp {
  const requests: HttpTransportRequest[] = [];
  const locals: LocalCall[] = [];
  return {
    requests,
    locals,
    transport: {
      http: async (request) => {
        requests.push(request);
        return answer(request, requests.length);
      },
      grpc: () => Promise.reject(new Error("The test Transport sends no gRPC.")),
      local: (call) => {
        locals.push(call);
        return local(call, locals.length);
      },
    },
  };
}

export type FakeResponse = HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> };

/** A response with this status, body, and headers. An object body is sent as JSON. */
export function reply(status: number, body?: unknown, headers: HeaderEntry[] = []): FakeResponse {
  let bytes: Uint8Array;
  let sent = headers;
  if (body === undefined) bytes = new Uint8Array(0);
  else if (typeof body === "string") bytes = encodeText(body);
  else if (body instanceof Uint8Array) bytes = body;
  else {
    bytes = encodeText(JSON.stringify(body));
    if (!headers.some(([name]) => name.toLowerCase() === "content-type")) {
      sent = [["content-type", "application/json"], ...headers];
    }
  }
  return {
    status,
    headers: sent,
    body: (async function* () {
      if (bytes.byteLength > 0) yield bytes;
    })(),
    cancel: vi.fn(),
  };
}

/** A response whose body arrives as these chunks. */
export function streamed(status: number, chunks: readonly string[], headers: HeaderEntry[]): FakeResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield encodeText(chunk);
    })(),
    cancel: vi.fn(),
  };
}

/** The request body as text. */
export function bodyText(request: HttpTransportRequest): string {
  return decodeText(request.body);
}

/** The request body parsed as JSON. */
export function bodyJson(request: HttpTransportRequest): unknown {
  const value: unknown = JSON.parse(decodeText(request.body));
  return value;
}

/** A header's value in the request, in any case. */
export function header(request: HttpTransportRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function shaping(overrides: Partial<ManifestShaping> = {}): ManifestShaping {
  return {
    hide: [],
    fixed: {},
    defaults: {},
    rename: {},
    select: [],
    redact: [],
    max_result_bytes: 65_536,
    deadline_ms: 30_000,
    ...overrides,
  };
}

export interface ContextOptions {
  transport: Transport;
  url?: string | undefined;
  network?: string;
  auth?: ManifestAuth | null;
  credential?: SendCredential;
  shaping?: Partial<ManifestShaping>;
  idempotency_key?: string;
  signal?: AbortSignal;
  server?: ManifestServer;
}

/** A SendContext for a server at https://api.example.com/v2, unless the options say otherwise. */
export function sendContext(options: ContextOptions): SendContext {
  return {
    server: options.server ?? ({ name: "example" } as unknown as ManifestServer),
    environment: {
      name: "sandbox",
      url: "url" in options ? options.url : "https://api.example.com/v2",
      network: options.network ?? "cloud",
    },
    auth: options.auth ?? null,
    credential: options.credential ?? { type: "none" },
    transport: options.transport,
    shaping: shaping(options.shaping),
    idempotency_key: options.idempotency_key,
    signal: options.signal ?? new AbortController().signal,
  };
}

// ── MCP ──────────────────────────────────────────────────────────────────────

/** A JSON-RPC response to request id, as a JSON body. */
export function rpcReply(id: number, result: unknown, headers: HeaderEntry[] = []): FakeResponse {
  return reply(200, { jsonrpc: "2.0", id, result }, headers);
}

/** A JSON-RPC error response to request id, as a JSON body. */
export function rpcFailure(id: number, error: unknown): FakeResponse {
  return reply(200, { jsonrpc: "2.0", id, error });
}

/** These JSON-RPC messages as an event stream, one event per chunk. */
export function eventStream(messages: readonly unknown[], headers: HeaderEntry[] = []): FakeResponse {
  const text = messages.map((message) => `event: message\ndata: ${JSON.stringify(message)}\n\n`);
  return streamed(200, text, [["content-type", "text/event-stream"], ...headers]);
}

/** A response whose body yields these chunks and then never ends. */
export function hanging(status: number, chunks: readonly string[] = [], headers: HeaderEntry[] = []): FakeResponse {
  return {
    status,
    headers,
    body: (async function* () {
      for (const chunk of chunks) yield encodeText(chunk);
      await new Promise<never>(() => undefined);
    })(),
    cancel: vi.fn(),
  };
}

export const SESSION_ID = "session-7f3a";

type Answer = Promise<HttpTransportResponse> | HttpTransportResponse;

export interface McpScript {
  /** The answer to initialize. By default a 200 with a session id and protocol 2025-06-18. */
  initialize?: (request: HttpTransportRequest) => Answer;
  /** The answer to notifications/initialized. By default a 202 with no body. */
  initialized?: (request: HttpTransportRequest) => Answer;
  /** The answer to tools/call. By default one text item. */
  call?: (request: HttpTransportRequest) => Answer;
  /** The answer to the DELETE. By default a 204. */
  close?: (request: HttpTransportRequest) => Answer;
}

/** The initialize answer mcpServer gives by default. */
export function initialized(protocolVersion = "2025-06-18", headers: HeaderEntry[] = [["Mcp-Session-Id", SESSION_ID]]): FakeResponse {
  return rpcReply(1, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }, headers);
}

function isDelete(request: HttpTransportRequest): boolean {
  return request.target.method === "DELETE";
}

/** The JSON-RPC method of a POST, or DELETE for the DELETE. */
export function mcpMethod(request: HttpTransportRequest): string {
  if (isDelete(request)) return "DELETE";
  const message = bodyJson(request);
  return isRecord(message) && typeof message.method === "string" ? message.method : "?";
}

/**
 * An answer function for fakeHttp that plays a streamable HTTP MCP server.
 * It routes on the HTTP method and the JSON-RPC method, not on call order,
 * so a retried initialize gets the same script.
 */
export function mcpServer(script: McpScript = {}): (request: HttpTransportRequest) => Promise<HttpTransportResponse> {
  return async (request) => {
    switch (mcpMethod(request)) {
      case "DELETE":
        return script.close === undefined ? reply(204) : script.close(request);
      case "initialize":
        return script.initialize === undefined ? initialized() : script.initialize(request);
      case "notifications/initialized":
        return script.initialized === undefined ? reply(202) : script.initialized(request);
      case "tools/call":
        return script.call === undefined ? rpcReply(2, { content: [{ type: "text", text: "ok" }] }) : script.call(request);
      default:
        throw new Error(`The fake MCP server got an unexpected message: ${bodyText(request)}`);
    }
  };
}

/** A ManifestServer with an MCP source and lock. Only the fields the MCP Sender reads are real. */
export function mcpManifestServer(source: Record<string, unknown>, pinned: Record<string, unknown>): ManifestServer {
  return { name: "files", source, pinned } as unknown as ManifestServer;
}

/** A remote streamable HTTP server. */
export const REMOTE_MCP = mcpManifestServer(
  { type: "remote", url: "https://mcp.example.com/mcp", transport: "http" },
  { type: "remote", url: "https://mcp.example.com/mcp", transport: "http" },
);
