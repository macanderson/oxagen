// transport.ts: a Transport that answers from a recorded call instead of the
// network (mcp-studio-spec, Try it and tests: replay in the PR).
//
// Each request the executor sends takes the next recorded response, in order.
// A retry of a 429, 502, 503, or 504 takes the same response again, because
// the recording keeps only a send's final attempt. A remote MCP server gets a
// fake session: initialize and notifications/initialized are answered here,
// and only tools/call takes a recorded response. A request past the end of
// the recording fails with a TransportError the executor never retries.
import type { RecordedExchange } from "../contract/tests-files";
import { decodeText, encodeText, isJsonMediaType, parseJson } from "../execute/body";
import { RETRY_STATUSES } from "../execute/http-call";
import { MCP_PROTOCOL_VERSION, toolResult } from "../execute/mcp";
import {
  TransportError,
  type HeaderEntry,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type Transport,
} from "../execute/transport";
import { isList, isRecord } from "../execute/util";

type RecordedResponse = RecordedExchange["response"];
type HttpResponse = Extract<RecordedResponse, { status: number }>;
type McpResponse = Extract<RecordedResponse, { content: unknown }>;

/** How the executor reaches the server: plain HTTP requests, a remote MCP session, or the local gateway. */
export type ReplayRoute = "http" | "mcp" | "local";

/** Why the recording could not answer a request. */
export interface ReplayProblem {
  /** exchanges: the executor sent more requests than the recording holds. response: a response does not fit the request. */
  part: "exchanges" | "response";
  /** 1-based: the exchange the request would have taken. */
  exchange: number;
  /** What the recording holds: its exchange count, or the kind of response it recorded. */
  expected: unknown;
  /** What the executor asked for: its request count, or the kind of response it needed. */
  actual: unknown;
  message: string;
}

export interface ReplayTransport {
  transport: Transport;
  /** How many recorded responses the executor took. A retry of one counts once. */
  used(): number;
  /** The first request the recording could not answer, if any. */
  problem(): ReplayProblem | undefined;
}

/** Response headers the replay leaves out: a recorded Retry-After would make every retry wait. */
const DROPPED_HEADERS: ReadonlySet<string> = new Set(["retry-after", "content-length"]);

const SERVER_INFO = { name: "oxagen-replay", version: "1" } as const;

function isHttpResponse(response: RecordedResponse): response is HttpResponse {
  return Object.hasOwn(response, "status");
}

function isMcpResponse(response: RecordedResponse): response is McpResponse {
  return Object.hasOwn(response, "content");
}

function responseKind(response: RecordedResponse): string {
  if (isHttpResponse(response)) return "an HTTP response";
  if (isMcpResponse(response)) return "an MCP tools/call result";
  return "a gRPC response";
}

function served(status: number, headers: readonly HeaderEntry[], bytes: Uint8Array): HttpTransportResponse {
  return {
    status,
    headers,
    body: (async function* () {
      if (bytes.byteLength > 0) yield bytes;
    })(),
    cancel: () => undefined,
  };
}

/** A recorded HTTP response as bytes on the wire. A JSON body is written as JSON, and text as it was. */
export function servedHttp(response: HttpResponse): HttpTransportResponse {
  const headers: HeaderEntry[] = Object.entries(response.headers ?? {}).filter(
    ([name]) => !DROPPED_HEADERS.has(name.toLowerCase()),
  );
  const contentType = headers.find(([name]) => name.toLowerCase() === "content-type")?.[1];
  const body: unknown = response.body;
  let bytes: Uint8Array;
  if (body === undefined) bytes = new Uint8Array(0);
  else if (typeof body === "string" && !isJsonMediaType(contentType)) bytes = encodeText(body);
  else {
    bytes = encodeText(JSON.stringify(body));
    if (contentType === undefined) headers.push(["content-type", "application/json"]);
  }
  return served(response.status, headers, bytes);
}

function jsonReply(id: unknown, result: unknown): HttpTransportResponse {
  return served(200, [["content-type", "application/json"]], encodeText(JSON.stringify({ jsonrpc: "2.0", id, result })));
}

/** The JSON-RPC message an MCP request carries, or undefined when the body is not one. */
function rpcMessage(request: HttpTransportRequest): Record<string, unknown> | undefined {
  const parsed = parseJson(decodeText(request.body));
  if (!parsed.ok) return undefined;
  const value = isList(parsed.value) ? parsed.value[0] : parsed.value;
  return isRecord(value) ? value : undefined;
}

/** A Transport that serves the exchanges' responses in order, for a call on this route. */
export function replayTransport(exchanges: readonly RecordedExchange[], route: ReplayRoute): ReplayTransport {
  let next = 0;
  let retryable = false;
  let problem: ReplayProblem | undefined;

  /** Note the first problem, then fail the request so the executor stops. */
  const refuse = (found: ReplayProblem): never => {
    problem ??= found;
    throw new TransportError("unsupported", found.message, false);
  };

  /** Exchange `exchange` recorded a response of another kind than the one the tool needs. */
  const wrongKind = (exchange: number, response: RecordedResponse, needed: string, reason: string): never => {
    const recorded = responseKind(response);
    return refuse({
      part: "response",
      exchange,
      expected: recorded,
      actual: needed,
      message: `Exchange ${exchange} records ${recorded}, but ${reason}.`,
    });
  };

  /** The next recorded response, or the last one again when the executor retries it. */
  const take = (): RecordedResponse => {
    const again = retryable ? exchanges[next - 1] : undefined;
    if (again !== undefined) return again.response;
    const exchange = exchanges[next];
    if (exchange === undefined) {
      return refuse({
        part: "exchanges",
        exchange: next + 1,
        expected: exchanges.length,
        actual: next + 1,
        message: `The executor sent request ${next + 1}, but the recording holds ${exchanges.length}.`,
      });
    }
    next += 1;
    retryable = false;
    return exchange.response;
  };

  const takeHttp = (): HttpTransportResponse => {
    const response = take();
    if (!isHttpResponse(response)) return wrongKind(next, response, "an HTTP response", "the tool sends HTTP requests");
    retryable = RETRY_STATUSES.has(response.status);
    return servedHttp(response);
  };

  const mcpSession = (request: HttpTransportRequest): HttpTransportResponse => {
    if (request.target.method === "DELETE") return served(204, [], new Uint8Array(0));
    const message = rpcMessage(request);
    const method = message?.method;
    if (method === "initialize") {
      return jsonReply(message?.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    if (method === "notifications/initialized") return served(202, [], new Uint8Array(0));
    if (method !== "tools/call") {
      return refuse({
        part: "response",
        exchange: next + 1,
        expected: "tools/call",
        actual: method,
        message: `The replay has no answer for the MCP request ${JSON.stringify(method ?? null)}.`,
      });
    }
    const response = take();
    if (isMcpResponse(response)) return jsonReply(message?.id, response);
    if (isHttpResponse(response)) return servedHttp(response);
    return wrongKind(next, response, "an MCP tools/call result", "the tool is on an MCP server");
  };

  const transport: Transport = {
    http: async (request) => (route === "mcp" ? mcpSession(request) : takeHttp()),
    grpc: async () =>
      refuse({
        part: "response",
        exchange: next + 1,
        expected: undefined,
        actual: "a gRPC call",
        message: "Replay does not run gRPC calls.",
      }),
    local: async () => {
      const response = take();
      if (!isMcpResponse(response)) {
        return wrongKind(next, response, "an MCP tools/call result", "the tool runs on the local gateway");
      }
      const checked = toolResult(response);
      if (checked.ok) return checked.value;
      return refuse({
        part: "response",
        exchange: next,
        expected: response,
        actual: undefined,
        message: `Exchange ${next} records a tools/call result the executor cannot read. ${checked.detail}`,
      });
    },
  };

  return { transport, used: () => next, problem: () => problem };
}
