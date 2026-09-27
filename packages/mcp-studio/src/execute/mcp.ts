// mcp.ts: the Sender for an MCP server's tool (mcp-studio-spec, Call path,
// step 5; Retry), and the local route for a server the local gateway runs.
//
// A remote server speaks streamable HTTP (MCP 2025-06-18). Each call opens
// one session: initialize, notifications/initialized, tools/call, then a
// DELETE that ends the session. The server answers each request with JSON or
// with an event stream, and the executor reads either. A failure before
// tools/call is sent may be retried, because the server has not acted. Once
// tools/call may have reached the server, the call is never retried, because
// the tool may have run.
//
// A server on the older HTTP+SSE transport is refused before anything is
// sent. The relay carries streamable HTTP only, and so does this Sender.
import type { ManifestServer, ManifestTool } from "../contract/manifest";
import type { RecordedExchange } from "../contract/tests-files";
import type { McpRequest } from "../model/upstream-tool";
import { placeCredential } from "./apply-credential";
import { decodeText, encodeText, parseJson, readBody, readChunks, SseParser, transportFailure, type SseEvent } from "./body";
import type { RelayCredential } from "./credentials";
import { headerValue, recordHttpResponse } from "./exchange";
import {
  cookieHeader,
  cutDetail,
  httpTarget,
  parseEndpoint,
  queryPair,
  RETRY_STATUSES,
  sendFailure,
  settle,
  upstreamError,
  withQuery,
} from "./http-call";
import { Clock, defaultBackoff, retryAfterMs, stopError, withRetries, type Attempt } from "./retry";
import type { SendContext, SendError, SendResult, Sender, UpstreamArguments } from "./sender";
import {
  TransportError,
  type CallToolResult,
  type HeaderEntry,
  type HttpTarget,
  type HttpTransportResponse,
} from "./transport";
import { BuildError, isList, isRecord } from "./util";

/** The protocol version the executor asks for in initialize. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** The session flow's own revision, not the release number. Raise it when the flow changes. */
const CLIENT_INFO = { name: "oxagen-gateway", version: "1" } as const;
const INITIALIZE_ID = 1;
const CALL_ID = 2;
/** The DELETE that ends a session gets its own short deadline, and nothing waits for it. */
const CLOSE_TIMEOUT_MS = 5_000;
/** A session id is visible ASCII (MCP 2025-06-18, Session Management). */
const SESSION_ID = /^[\x21-\x7e]{1,1024}$/;
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPT = "application/json, text/event-stream";

export interface McpSenderOptions {
  /** The wait before retry n when the server sent no Retry-After. */
  backoff_ms?: (retry: number) => number;
}

// ── Results ──────────────────────────────────────────────────────────────────

/**
 * A tools/call result, checked and copied. Only content, structuredContent,
 * and isError are kept, so _meta and anything else the server adds stays
 * out of the result and the record. A null structuredContent or isError
 * counts as absent.
 */
export function toolResult(value: unknown): { ok: true; value: CallToolResult } | { ok: false; detail: string } {
  if (!isRecord(value)) return { ok: false, detail: "The tools/call result is not an object." };
  if (!isList(value.content)) return { ok: false, detail: "The tools/call result has no content list." };
  const content: Array<{ type: string } & Record<string, unknown>> = [];
  for (const [index, item] of value.content.entries()) {
    if (!isRecord(item) || typeof item.type !== "string") {
      return { ok: false, detail: `Content item ${index} is not an object with a string type.` };
    }
    content.push({ ...item, type: item.type });
  }
  const result: CallToolResult = { content };
  const structured = value.structuredContent;
  if (structured !== undefined && structured !== null) {
    if (!isRecord(structured)) return { ok: false, detail: "The tools/call result's structuredContent is not an object." };
    result.structuredContent = structured;
  }
  const isError = value.isError;
  if (isError !== undefined && isError !== null) {
    if (typeof isError !== "boolean") return { ok: false, detail: "The tools/call result's isError is not a boolean." };
    result.isError = isError;
  }
  return { ok: true, value: result };
}

/** A tools/call exchange as calls.jsonl records it. */
function recordedCall(name: string, args: UpstreamArguments, result: CallToolResult): RecordedExchange {
  return {
    request: { name, arguments: args },
    response: {
      content: result.content.map((item) => ({ ...item })),
      ...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
      ...(result.isError === undefined ? {} : { isError: result.isError }),
    },
  };
}

// ── Retry rule ───────────────────────────────────────────────────────────────

/**
 * True when the Transport says the request never left, so a retry cannot run
 * the tool twice. A refusal is final, so it is not retried either.
 */
function retryableTransportFailure(error: unknown): boolean {
  return (
    error instanceof TransportError &&
    !error.sent &&
    !error.code.startsWith("refused_") &&
    error.code !== "unsupported"
  );
}

/** A Transport failure as an attempt's error, with retry when nothing was sent. */
function failedSend(error: unknown): Attempt<never> {
  const failure = transportFailure(error).error;
  return retryableTransportFailure(error)
    ? { ok: false, error: failure, retry: { after_ms: undefined } }
    : { ok: false, error: failure };
}

// ── Building ─────────────────────────────────────────────────────────────────

/** A remote call, ready to send: the targets and what every request of the session carries. */
interface McpCall {
  context: SendContext;
  template: McpRequest;
  args: UpstreamArguments;
  post: HttpTarget;
  close: HttpTarget;
  auth_headers: HeaderEntry[];
  relay_credential: RelayCredential | undefined;
  backoff_ms: (retry: number) => number;
}

function unsupportedTransport(detail: string): BuildError {
  return new BuildError("Unsupported transport", detail);
}

/** Refuse a server this Sender cannot reach before anything is sent. */
function checkTransport(server: ManifestServer, network: string): void {
  if (network === "local") {
    throw unsupportedTransport(
      `${server.name} runs on the local gateway, so its calls go through the local route, not a remote MCP session.`,
    );
  }
  const source = server.source;
  const pinned = server.pinned;
  const sse =
    (source.type === "remote" && source.transport === "sse") ||
    (pinned.type === "registry" && pinned.transport === "sse");
  if (sse) {
    throw unsupportedTransport(
      `${server.name} uses the HTTP+SSE transport. The gateway calls MCP servers over streamable HTTP only.`,
    );
  }
}

function buildMcpCall(
  template: McpRequest,
  args: UpstreamArguments,
  context: SendContext,
  backoff_ms: (retry: number) => number,
): McpCall {
  checkTransport(context.server, context.environment.network);
  const endpoint = parseEndpoint(context.environment.url, "endpoint");
  // The record holds only the tool name and arguments, so no recording can hold the credential.
  const credential = placeCredential(context.auth, context.credential, context.environment.network);
  const path = withQuery(
    endpoint.path,
    credential.query.map(([name, value]) => queryPair(name, value)),
  );
  return {
    context,
    template,
    args,
    post: httpTarget(endpoint, "POST", path),
    close: httpTarget(endpoint, "DELETE", path),
    auth_headers: [...cookieHeader(credential.cookies), ...credential.headers],
    relay_credential: credential.relay_credential,
    backoff_ms,
  };
}

// ── One session ──────────────────────────────────────────────────────────────

interface McpSession {
  call: McpCall;
  deadline: number;
  clock: Clock;
  controller: AbortController;
  /** The Mcp-Session-Id the server assigned in its initialize response, if any. */
  id: string | undefined;
  /** The protocol version the server chose. */
  protocol: string | undefined;
}

/** The session headers every request after initialize carries. */
function sessionHeaders(session: McpSession): HeaderEntry[] {
  const headers: HeaderEntry[] = [];
  if (session.id !== undefined) headers.push(["Mcp-Session-Id", session.id]);
  if (session.protocol !== undefined) headers.push(["MCP-Protocol-Version", session.protocol]);
  return headers;
}

function invalidResponse(detail: string, status: number | undefined): Attempt<never> {
  return { ok: false, error: { title: "Invalid response", detail, status } };
}

/** POST one JSON-RPC message inside the call's deadline. */
async function post(session: McpSession, message: Record<string, unknown>): Promise<Attempt<HttpTransportResponse>> {
  const { call } = session;
  const context = call.context;
  const pending = settle(() =>
    context.transport.http({
      network: context.environment.network,
      deadline_ms: Math.max(1, session.deadline - Date.now()),
      signal: session.controller.signal,
      relay_credential: call.relay_credential,
      target: call.post,
      headers: [
        ["Accept", ACCEPT],
        ["Content-Type", "application/json"],
        ...sessionHeaders(session),
        ...call.auth_headers,
      ],
      body: encodeText(JSON.stringify(message)),
    }),
  );
  const sent = await session.clock.race(pending);
  if (sent.kind === "stopped") {
    // A response that arrives after the stop is released unread.
    pending.then(
      (late) => late.cancel(),
      () => undefined,
    );
    return { ok: false, error: stopError(sent.stop, context.shaping.deadline_ms) };
  }
  if (sent.kind === "failed") return failedSend(sent.error);
  return { ok: true, value: sent.value };
}

/**
 * The error for a response that is not a success. Before tools/call, a 429,
 * 502, 503, or 504 may be retried, after the server's Retry-After.
 */
async function rejected(
  session: McpSession,
  response: HttpTransportResponse,
  setup: boolean,
): Promise<{ error: SendError; bytes: Uint8Array; retry: boolean }> {
  const read = await readBody(response, { clock: session.clock, deadline_ms: session.call.context.shaping.deadline_ms });
  const bytes = read.ok ? read.bytes : new Uint8Array(0);
  return { error: upstreamError(response, bytes), bytes, retry: setup && RETRY_STATUSES.has(response.status) };
}

function rejectedAttempt(response: HttpTransportResponse, failure: { error: SendError; retry: boolean }): Attempt<never> {
  if (!failure.retry) return { ok: false, error: failure.error };
  const after_ms = retryAfterMs(headerValue(response.headers, "retry-after"), Date.now());
  return { ok: false, error: failure.error, retry: { after_ms } };
}

/** The JSON-RPC response to request id in one message or a list of them. Requests and notifications are skipped. */
function findResponse(value: unknown, id: number): Record<string, unknown> | undefined {
  const messages = isList(value) ? value : [value];
  for (const message of messages) {
    if (isRecord(message) && message.id === id && !Object.hasOwn(message, "method")) return message;
  }
  return undefined;
}

function isEventStream(contentType: string | undefined): boolean {
  return contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream";
}

/**
 * Read an event stream until the response to request id arrives, then stop
 * reading. The server may send notifications and its own requests first. The
 * executor declares no client capabilities, so it answers none of them and
 * reads past them.
 */
async function streamReply(
  session: McpSession,
  response: HttpTransportResponse,
  id: number,
  what: string,
): Promise<Attempt<Record<string, unknown>>> {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  const found: { message?: Record<string, unknown> } = {};
  const take = (events: readonly SseEvent[]): boolean => {
    for (const event of events) {
      if (event.event !== "message") continue;
      const parsed = parseJson(event.data);
      const message = parsed.ok ? findResponse(parsed.value, id) : undefined;
      if (message !== undefined) {
        found.message = message;
        return true;
      }
    }
    return false;
  };
  const read = await readChunks(
    response,
    { clock: session.clock, deadline_ms: session.call.context.shaping.deadline_ms },
    (chunk) => take(parser.push(decoder.decode(chunk, { stream: true }))),
  );
  if (!read.ok) return read;
  if (found.message === undefined) take([...parser.push(decoder.decode()), ...parser.end()]);
  if (found.message === undefined) {
    return invalidResponse(`The MCP server's event stream ended with no response to ${what}.`, response.status);
  }
  return { ok: true, value: found.message };
}

/** The JSON-RPC response to request id, from a JSON body or an event stream. */
async function readReply(
  session: McpSession,
  response: HttpTransportResponse,
  id: number,
  what: string,
): Promise<Attempt<Record<string, unknown>>> {
  if (isEventStream(headerValue(response.headers, "content-type"))) return streamReply(session, response, id, what);
  const read = await readBody(response, { clock: session.clock, deadline_ms: session.call.context.shaping.deadline_ms });
  if (!read.ok) return read;
  const status = response.status;
  if (read.bytes.byteLength === 0) return invalidResponse(`The MCP server answered ${what} with no body.`, status);
  const parsed = parseJson(decodeText(read.bytes));
  if (!parsed.ok) {
    return invalidResponse(`The MCP server answered ${what} with JSON that does not parse: ${parsed.message}`, status);
  }
  const message = findResponse(parsed.value, id);
  if (message === undefined) return invalidResponse(`The MCP server's answer holds no response to ${what}.`, status);
  return { ok: true, value: message };
}

/** A JSON-RPC error object as a SendError. No HTTP status applies. */
function rpcError(error: unknown): SendError {
  const message = isRecord(error) && typeof error.message === "string" ? error.message : JSON.stringify(error);
  const code = isRecord(error) && typeof error.code === "number" ? ` (code ${error.code})` : "";
  return { title: "MCP error", detail: cutDetail(`${message}${code}`), status: undefined };
}

async function initialize(session: McpSession): Promise<Attempt<undefined>> {
  const sent = await post(session, {
    jsonrpc: "2.0",
    id: INITIALIZE_ID,
    method: "initialize",
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
  });
  if (!sent.ok) return sent;
  const response = sent.value;
  if (response.status < 200 || response.status >= 300) {
    return rejectedAttempt(response, await rejected(session, response, true));
  }
  const id = headerValue(response.headers, "mcp-session-id");
  if (id !== undefined) {
    if (!SESSION_ID.test(id)) {
      response.cancel();
      return invalidResponse("The MCP server's Mcp-Session-Id is not visible ASCII.", response.status);
    }
    // Set before the body is read, so the session is closed even when the read fails.
    session.id = id;
  }
  const reply = await readReply(session, response, INITIALIZE_ID, "initialize");
  if (!reply.ok) return reply;
  if (Object.hasOwn(reply.value, "error")) return { ok: false, error: rpcError(reply.value.error) };
  const result = reply.value.result;
  if (!isRecord(result)) return invalidResponse("The MCP server's initialize result is not an object.", response.status);
  const version = result.protocolVersion;
  session.protocol = typeof version === "string" && PROTOCOL_VERSION.test(version) ? version : MCP_PROTOCOL_VERSION;
  return { ok: true, value: undefined };
}

async function notifyInitialized(session: McpSession): Promise<Attempt<undefined>> {
  const sent = await post(session, { jsonrpc: "2.0", method: "notifications/initialized" });
  if (!sent.ok) return sent;
  const response = sent.value;
  if (response.status < 200 || response.status >= 300) {
    return rejectedAttempt(response, await rejected(session, response, true));
  }
  // The answer is 202 with no body. Anything else in it is read and dropped.
  const read = await readBody(response, { clock: session.clock, deadline_ms: session.call.context.shaping.deadline_ms });
  return read.ok ? { ok: true, value: undefined } : read;
}

interface Outcome {
  attempt: Attempt<CallToolResult>;
  exchange: RecordedExchange | undefined;
}

async function callTool(session: McpSession): Promise<Outcome> {
  const { template, args } = session.call;
  const sent = await post(session, {
    jsonrpc: "2.0",
    id: CALL_ID,
    method: "tools/call",
    params: { name: template.tool, arguments: args },
  });
  if (!sent.ok) return { attempt: sent, exchange: undefined };
  const response = sent.value;
  if (response.status < 200 || response.status >= 300) {
    // The server may have run the tool, so this is never retried.
    const failure = await rejected(session, response, false);
    return {
      attempt: { ok: false, error: failure.error },
      exchange: { request: { name: template.tool, arguments: args }, response: recordHttpResponse(response, failure.bytes) },
    };
  }
  const reply = await readReply(session, response, CALL_ID, "tools/call");
  if (!reply.ok) return { attempt: reply, exchange: undefined };
  // A JSON-RPC error has no recorded response shape, so the exchange is left out.
  if (Object.hasOwn(reply.value, "error")) return { attempt: { ok: false, error: rpcError(reply.value.error) }, exchange: undefined };
  const result = toolResult(reply.value.result);
  if (!result.ok) return { attempt: invalidResponse(result.detail, response.status), exchange: undefined };
  return { attempt: result, exchange: recordedCall(template.tool, args, result.value) };
}

/** End the session. Nothing waits for it, and its failure changes nothing. */
function closeSession(session: McpSession): void {
  if (session.id === undefined) return;
  const { call } = session;
  const context = call.context;
  settle(() =>
    context.transport.http({
      network: context.environment.network,
      deadline_ms: CLOSE_TIMEOUT_MS,
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      relay_credential: call.relay_credential,
      target: call.close,
      headers: [...sessionHeaders(session), ...call.auth_headers],
      body: new Uint8Array(0),
    }),
  ).then(
    (response) => response.cancel(),
    () => undefined,
  );
}

async function attemptOnce(call: McpCall, deadline: number): Promise<Outcome> {
  const controller = new AbortController();
  const session: McpSession = {
    call,
    deadline,
    clock: new Clock(deadline, call.context.signal, controller),
    controller,
    id: undefined,
    protocol: undefined,
  };
  try {
    const initialized = await initialize(session);
    if (!initialized.ok) return { attempt: initialized, exchange: undefined };
    const notified = await notifyInitialized(session);
    if (!notified.ok) return { attempt: notified, exchange: undefined };
    return await callTool(session);
  } finally {
    closeSession(session);
    session.clock.dispose();
  }
}

/** Run attempts under one deadline. The result carries the final attempt's exchange, when one was recorded. */
async function runAttempts(
  context: SendContext,
  backoff_ms: (retry: number) => number,
  attempt: (deadline: number) => Promise<Outcome>,
): Promise<SendResult> {
  const deadline = Date.now() + context.shaping.deadline_ms;
  let exchange: RecordedExchange | undefined;
  const result = await withRetries(
    async () => {
      const outcome = await attempt(deadline);
      exchange = outcome.exchange;
      return outcome.attempt;
    },
    { deadline, signal: context.signal, backoff_ms },
  );
  const exchanges = exchange === undefined ? [] : [exchange];
  return result.ok
    ? { ok: true, value: result.value, attempts: result.attempts, exchanges }
    : { ok: false, error: result.error, attempts: result.attempts, exchanges };
}

/** The Sender for a remote MCP server's tool. */
export function createMcpSender(options: McpSenderOptions = {}): Sender<"mcp"> {
  const backoff_ms = options.backoff_ms ?? defaultBackoff;
  return {
    kind: "mcp",
    async send(template, args, context) {
      try {
        const call = buildMcpCall(template, args, context, backoff_ms);
        return await runAttempts(context, backoff_ms, (deadline) => attemptOnce(call, deadline));
      } catch (error) {
        return sendFailure(error, "MCP");
      }
    },
  };
}

// ── Local route ──────────────────────────────────────────────────────────────

/** The digest the local gateway checks before it starts the server's package. */
function packageDigest(server: ManifestServer): string {
  const pinned = server.pinned;
  if (pinned.type === "local") return pinned.package.digest;
  if (pinned.type === "registry" && pinned.package !== undefined) return pinned.package.digest;
  throw new BuildError(
    "Invalid environment",
    `${server.name} is on the local network, but its lock pins no package for the local gateway to start.`,
  );
}

/**
 * Call a tool on a server the local gateway runs. The Transport carries the
 * call to the local gateway on the agent's machine, which checks the package
 * digest and runs tools/call. The retry rule is the remote one: only a call
 * the Transport says never left is sent again.
 */
export async function sendLocal(
  tool: ManifestTool,
  args: UpstreamArguments,
  context: SendContext,
  options: McpSenderOptions = {},
): Promise<SendResult> {
  const backoff_ms = options.backoff_ms ?? defaultBackoff;
  try {
    const template = tool.request;
    if (template.kind !== "mcp") {
      throw new BuildError("Invalid request", `${tool.name} is a ${template.kind} tool, and only an MCP tool runs locally.`);
    }
    if (context.environment.network !== "local") {
      throw new BuildError(
        "Invalid environment",
        `The local route needs the local network, but this environment's network is ${context.environment.network}.`,
      );
    }
    const package_digest = packageDigest(context.server);
    return await runAttempts(context, backoff_ms, async (deadline) => {
      const controller = new AbortController();
      const clock = new Clock(deadline, context.signal, controller);
      try {
        const pending = settle(() =>
          context.transport.local({
            tool: tool.definition.name,
            upstream: template.tool,
            version: tool.version,
            definition_hash: tool.definition_hash,
            package_digest,
            arguments: args,
            deadline_ms: Math.max(1, deadline - Date.now()),
            signal: controller.signal,
          }),
        );
        const sent = await clock.race(pending);
        if (sent.kind === "stopped") {
          return { attempt: { ok: false, error: stopError(sent.stop, context.shaping.deadline_ms) }, exchange: undefined };
        }
        if (sent.kind === "failed") return { attempt: failedSend(sent.error), exchange: undefined };
        const result = toolResult(sent.value);
        if (!result.ok) return { attempt: invalidResponse(result.detail, undefined), exchange: undefined };
        return { attempt: result, exchange: recordedCall(template.tool, args, result.value) };
      } finally {
        clock.dispose();
      }
    });
  } catch (error) {
    return sendFailure(error, "local MCP");
  }
}
