// mcp-client.ts: the requests discovery sends upstream, all through the
// Transport (lane M10, #4682; mcp-studio-spec, Sync).
//
// - listMcpTools: an MCP session that pages through tools/list.
// - introspectGraphql: a GraphQL introspection query.
// - fetchText: a GET for a definition or a registry entry.
//
// The executor's MCP Sender opens a session for one tools/call. Discovery
// needs the whole tool list, so this file opens its own session under the
// same rules: the same headers, the same checks on the session id and the
// protocol version, and the same credential placement. Every request goes
// through the Transport, so the cloud route's address checks apply. Every
// secret this file places goes into the run's scrubber first.
import {
  hostSchema,
  MCP_PROTOCOL_VERSION,
  mcpToolsListResultSchema,
  relayHttpTargetSchema,
  TransportError,
  type HeaderEntry,
  type HttpTarget,
  type HttpTransportResponse,
  type ManifestAuth,
  type McpTool,
  type SendCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import type { Scrubber } from "./scrub";
import { DiscoveryRefused } from "./types";

/** Each request's deadline when the caller sets none. */
export const REQUEST_DEADLINE_MS = 30_000;
/** The most bytes one MCP reply may hold. */
export const MCP_REPLY_BYTES_MAX = 8 * 1024 * 1024;
/** tools/list stops with a refusal past this many pages. */
export const TOOLS_PAGES_MAX = 50;
/** tools/list stops with a refusal past this many tools. */
export const TOOLS_MAX = 2000;

/** The session flow's own revision, not the release number. */
const CLIENT_INFO = { name: "oxagen-discovery", version: "1" } as const;
const INITIALIZE_ID = 1;
/** The DELETE that ends a session gets its own short deadline. */
const CLOSE_TIMEOUT_MS = 5_000;
/** A session id is visible ASCII (MCP 2025-06-18, Session Management). */
const SESSION_ID = /^[\x21-\x7e]{1,1024}$/;
const PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPT = "application/json, text/event-stream";
// CR and LF would end a header early, and NUL ends it in some servers.
const UNSAFE = /[\r\n\0]/;

function refused(message: string): DiscoveryRefused {
  return new DiscoveryRefused("source", message);
}

// ── The endpoint ─────────────────────────────────────────────────────────────

interface Endpoint {
  scheme: "https" | "http";
  host: string;
  port: number | undefined;
  /** The path and query, sent as written. */
  path: string;
}

/** Read a url as the executor reads an MCP or GraphQL endpoint. */
export function parseEndpoint(url: string): Endpoint {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw refused(`The url ${url} does not parse.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw refused(
      `A url is https or http, not ${parsed.protocol.slice(0, -1)}.`,
    );
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw refused(
      "A url cannot carry a user name or password. Store the secret as a credential.",
    );
  }
  if (parsed.hash !== "") throw refused(`A url has no fragment: ${url}.`);
  if (parsed.hostname.startsWith("[")) {
    throw refused(
      "An IPv6 host is not supported. Name the host, or use an IPv4 address.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  if (!hostSchema.safeParse(host).success) {
    throw refused(`${host} is not a host name or an IPv4 address.`);
  }
  return {
    scheme: parsed.protocol === "https:" ? "https" : "http",
    host,
    port: parsed.port === "" ? undefined : Number(parsed.port),
    path: parsed.pathname + parsed.search,
  };
}

function targetOf(
  endpoint: Endpoint,
  method: "GET" | "POST" | "DELETE",
  path: string,
): HttpTarget {
  const target = relayHttpTargetSchema.safeParse({
    kind: "http",
    scheme: endpoint.scheme,
    method,
    host: endpoint.host,
    port: endpoint.port,
    path,
  });
  if (!target.success) {
    throw refused(`The request to ${endpoint.host} has a path no request can carry.`);
  }
  return target.data;
}

function withQuery(path: string, pairs: readonly string[]): string {
  if (pairs.length === 0) return path;
  return `${path}${path.includes("?") ? "&" : "?"}${pairs.join("&")}`;
}

// ── The credential ───────────────────────────────────────────────────────────

/** What one request adds for the credential. */
export interface PlacedCredential {
  headers: HeaderEntry[];
  /** Query pairs, percent-encoded. */
  query: string[];
}

function checked(value: string, what: string): string {
  if (UNSAFE.test(value)) {
    throw new DiscoveryRefused(
      "credential",
      `The ${what} holds a line break or a NUL, so no request can carry it.`,
    );
  }
  return value;
}

/**
 * Place the credential as the executor does: a bearer token or a basic pair
 * in Authorization, and an API key where the scheme names. Each value goes
 * into the scrubber before any request carries it.
 */
export function placeCredential(
  auth: ManifestAuth | null,
  credential: SendCredential,
  scrubber: Scrubber,
): PlacedCredential {
  switch (credential.type) {
    case "none":
      return { headers: [], query: [] };
    case "relay":
      throw new DiscoveryRefused(
        "unsupported",
        "Discovery through a relay is not available yet.",
      );
    case "bearer": {
      const token = checked(credential.token, "access token");
      scrubber.add(token);
      return { headers: [["Authorization", `Bearer ${token}`]], query: [] };
    }
    case "basic": {
      const username = checked(credential.username, "user name");
      if (username.includes(":")) {
        throw new DiscoveryRefused(
          "credential",
          "A basic credential's user name cannot hold a colon (RFC 7617).",
        );
      }
      const password = checked(credential.password, "password");
      scrubber.add(password);
      const pair = Buffer.from(`${username}:${password}`, "utf8").toString(
        "base64",
      );
      scrubber.add(pair);
      return { headers: [["Authorization", `Basic ${pair}`]], query: [] };
    }
    case "api_key": {
      const apply = auth?.apply;
      if (
        apply?.type !== "api_key" ||
        apply.name === undefined ||
        apply.in === undefined
      ) {
        throw new DiscoveryRefused(
          "credential",
          "An API key needs an api_key auth scheme that names where it goes.",
        );
      }
      const value = checked(credential.value, "API key");
      scrubber.add(value);
      switch (apply.in) {
        case "header":
          return { headers: [[apply.name, value]], query: [] };
        case "query":
          return {
            headers: [],
            query: [
              `${encodeURIComponent(apply.name)}=${encodeURIComponent(value)}`,
            ],
          };
        case "cookie":
          if (/[;,\s"\\]/.test(value)) {
            throw new DiscoveryRefused(
              "credential",
              "The API key holds a character a cookie cannot carry: a space, a quote, a comma, a semicolon, or a backslash.",
            );
          }
          return { headers: [["Cookie", `${apply.name}=${value}`]], query: [] };
      }
    }
  }
}

// ── Sending and reading ──────────────────────────────────────────────────────

interface Route {
  transport: Transport;
  endpoint: Endpoint;
  /** The endpoint's path with the credential's query pairs. */
  path: string;
  /** The credential's headers. */
  auth: HeaderEntry[];
  signal: AbortSignal;
  deadlineMs: number;
}

function routeOf(options: {
  url: string;
  network: string;
  placed: PlacedCredential;
  transport: Transport;
  signal: AbortSignal;
  deadlineMs: number | undefined;
}): Route {
  if (options.network !== "cloud") {
    throw new DiscoveryRefused(
      "unsupported",
      "Discovery through a relay is not available yet.",
    );
  }
  const endpoint = parseEndpoint(options.url);
  const deadlineMs = options.deadlineMs ?? REQUEST_DEADLINE_MS;
  return {
    transport: options.transport,
    endpoint,
    path: withQuery(endpoint.path, options.placed.query),
    auth: options.placed.headers,
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(deadlineMs)]),
    deadlineMs,
  };
}

function failed(route: Route, error: unknown): DiscoveryRefused {
  if (error instanceof DiscoveryRefused) return error;
  if (route.signal.aborted) {
    return refused(
      `${route.endpoint.host} did not answer within ${route.deadlineMs / 1000} seconds.`,
    );
  }
  if (error instanceof TransportError) {
    return refused(
      `The request to ${route.endpoint.host} failed: ${error.message}`,
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return refused(`The request to ${route.endpoint.host} failed: ${message}`);
}

async function send(
  route: Route,
  method: "GET" | "POST",
  headers: readonly HeaderEntry[],
  body: string,
): Promise<HttpTransportResponse> {
  try {
    return await route.transport.http({
      network: "cloud",
      deadline_ms: route.deadlineMs,
      signal: route.signal,
      relay_credential: undefined,
      target: targetOf(route.endpoint, method, route.path),
      headers: [...headers, ...route.auth],
      body: new TextEncoder().encode(body),
    });
  } catch (error) {
    throw failed(route, error);
  }
}

function nextChunk(
  iterator: AsyncIterator<Uint8Array>,
  signal: AbortSignal,
): Promise<IteratorResult<Uint8Array>> {
  if (signal.aborted) return Promise.reject(new Error("aborted"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/**
 * Read the body chunk by chunk, each read raced against the deadline.
 * onChunk returns true when it has what it needs, which ends the read. The
 * response is cancelled whenever the read ends before the body does.
 */
async function readBody(
  route: Route,
  response: HttpTransportResponse,
  max: number,
  onChunk?: (chunk: Uint8Array) => boolean,
): Promise<Uint8Array> {
  const iterator = response.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let done = false;
  try {
    for (;;) {
      const next = await nextChunk(iterator, route.signal);
      if (next.done === true) {
        done = true;
        break;
      }
      size += next.value.byteLength;
      if (size > max) {
        throw refused(
          `${route.endpoint.host} sent more than ${max} bytes in one reply.`,
        );
      }
      chunks.push(next.value);
      if (onChunk?.(next.value) === true) break;
    }
  } catch (error) {
    throw failed(route, error);
  } finally {
    if (!done) response.cancel();
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

function headerValue(
  headers: readonly HeaderEntry[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function statusError(
  route: Route,
  what: string,
  status: number,
): DiscoveryRefused {
  return refused(
    `${route.endpoint.host} answered ${what} with HTTP ${status}.`,
  );
}

// ── Server-sent events ───────────────────────────────────────────────────────

interface SseEvent {
  event: string;
  data: string;
}

/** The executor's event-stream parser (execute/body.ts), line for line. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];

  push(text: string): SseEvent[] {
    this.buffer += text;
    const events: SseEvent[] = [];
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      // A lone \r at the end may be the first half of \r\n, so wait for more.
      if (
        match === null ||
        (match[0] === "\r" && match.index === this.buffer.length - 1)
      ) {
        break;
      }
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const event = this.line(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /** The end of the stream. An event with no blank line after it is dropped. */
  end(): SseEvent[] {
    const events = this.push("");
    if (this.buffer.endsWith("\r")) {
      const event = this.line(this.buffer.slice(0, -1));
      if (event !== undefined) events.push(event);
    }
    this.buffer = "";
    this.event = "";
    this.data = [];
    return events;
  }

  private line(line: string): SseEvent | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return undefined;
      }
      const event = {
        event: this.event === "" ? "message" : this.event,
        data: this.data.join("\n"),
      };
      this.event = "";
      this.data = [];
      return event;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    return undefined;
  }
}

// ── The MCP session ──────────────────────────────────────────────────────────

/** The response to id: the message itself, or one element of a batch. */
function findResponse(
  value: unknown,
  id: number,
): Record<string, unknown> | undefined {
  const messages = Array.isArray(value) ? value : [value];
  for (const message of messages) {
    if (isRecord(message) && message.id === id && !("method" in message)) {
      return message;
    }
  }
  return undefined;
}

function isEventStream(contentType: string | undefined): boolean {
  return (
    contentType?.split(";")[0]?.trim().toLowerCase() === "text/event-stream"
  );
}

function rpcError(what: string, error: unknown): DiscoveryRefused {
  const message =
    isRecord(error) && typeof error.message === "string"
      ? error.message
      : "no message";
  const code =
    isRecord(error) && typeof error.code === "number"
      ? ` (code ${error.code})`
      : "";
  return refused(`The MCP server refused ${what}: ${message}${code}`);
}

/** The JSON-RPC response to id, from a JSON body or an event stream. */
async function reply(
  route: Route,
  response: HttpTransportResponse,
  id: number,
  what: string,
): Promise<Record<string, unknown>> {
  if (isEventStream(headerValue(response.headers, "content-type"))) {
    const parser = new SseParser();
    const decoder = new TextDecoder();
    const state: { found: Record<string, unknown> | undefined } = {
      found: undefined,
    };
    const take = (events: SseEvent[]): boolean => {
      for (const event of events) {
        if (event.event !== "message") continue;
        const parsed = parseJson(event.data);
        const message = parsed.ok ? findResponse(parsed.value, id) : undefined;
        if (message !== undefined) {
          state.found = message;
          return true;
        }
      }
      return false;
    };
    await readBody(route, response, MCP_REPLY_BYTES_MAX, (chunk) =>
      take(parser.push(decoder.decode(chunk, { stream: true }))),
    );
    if (state.found === undefined) take(parser.end());
    const found = state.found;
    if (found === undefined) {
      throw refused(
        `The MCP server's event stream ended with no response to ${what}.`,
      );
    }
    return found;
  }
  const bytes = await readBody(route, response, MCP_REPLY_BYTES_MAX);
  if (bytes.byteLength === 0) {
    throw refused(`The MCP server answered ${what} with no body.`);
  }
  const parsed = parseJson(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    throw refused(`The MCP server answered ${what} with JSON that does not parse.`);
  }
  const message = findResponse(parsed.value, id);
  if (message === undefined) {
    throw refused(`The MCP server's answer holds no response to ${what}.`);
  }
  return message;
}

function rpcBody(id: number, method: string, params: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

const BASE_HEADERS: readonly HeaderEntry[] = [
  ["Accept", ACCEPT],
  ["Content-Type", "application/json"],
];

interface Session {
  headers: HeaderEntry[];
  serverVersion: string | undefined;
}

async function initialize(route: Route): Promise<Session> {
  const response = await send(
    route,
    "POST",
    BASE_HEADERS,
    rpcBody(INITIALIZE_ID, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw statusError(route, "initialize", response.status);
  }
  const sessionId = headerValue(response.headers, "mcp-session-id");
  if (sessionId !== undefined && !SESSION_ID.test(sessionId)) {
    response.cancel();
    throw refused("The MCP server's Mcp-Session-Id is not visible ASCII.");
  }
  const message = await reply(route, response, INITIALIZE_ID, "initialize");
  if (Object.hasOwn(message, "error")) {
    throw rpcError("initialize", message.error);
  }
  const result = message.result;
  if (!isRecord(result)) {
    throw refused("The MCP server's initialize result is not an object.");
  }
  const protocol =
    typeof result.protocolVersion === "string" &&
    PROTOCOL_VERSION.test(result.protocolVersion)
      ? result.protocolVersion
      : MCP_PROTOCOL_VERSION;
  const info = result.serverInfo;
  const version =
    isRecord(info) &&
    typeof info.version === "string" &&
    info.version.length >= 1 &&
    info.version.length <= 64
      ? info.version
      : undefined;
  const headers: HeaderEntry[] = [["MCP-Protocol-Version", protocol]];
  if (sessionId !== undefined) headers.unshift(["Mcp-Session-Id", sessionId]);
  return { headers, serverVersion: version };
}

async function notifyInitialized(route: Route, session: Session): Promise<void> {
  const response = await send(
    route,
    "POST",
    [...BASE_HEADERS, ...session.headers],
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw statusError(route, "notifications/initialized", response.status);
  }
  await readBody(route, response, MCP_REPLY_BYTES_MAX);
}

/** End the session. Nothing waits for it, and a failure changes nothing. */
function closeSession(route: Route, session: Session): void {
  if (!session.headers.some(([name]) => name === "Mcp-Session-Id")) return;
  void route.transport
    .http({
      network: "cloud",
      deadline_ms: CLOSE_TIMEOUT_MS,
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
      relay_credential: undefined,
      target: targetOf(route.endpoint, "DELETE", route.path),
      headers: [...session.headers, ...route.auth],
      body: new Uint8Array(),
    })
    .then(
      (response) => response.cancel(),
      () => undefined,
    );
}

export interface McpListRequest {
  url: string;
  /** cloud, or relay:<name>. Only cloud is reached today. */
  network: string;
  auth: ManifestAuth | null;
  credential: SendCredential;
  transport: Transport;
  scrubber: Scrubber;
  signal: AbortSignal;
  deadlineMs?: number;
}

export interface McpListResult {
  tools: McpTool[];
  /** initialize's serverInfo.version, when it fits a lock. */
  serverVersion: string | undefined;
}

/** Open a session, page through tools/list, and end the session. */
export async function listMcpTools(
  request: McpListRequest,
): Promise<McpListResult> {
  const placed = placeCredential(
    request.auth,
    request.credential,
    request.scrubber,
  );
  const route = routeOf({ ...request, placed });
  const session = await initialize(route);
  try {
    await notifyInitialized(route, session);
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < TOOLS_PAGES_MAX; page += 1) {
      const id = INITIALIZE_ID + 1 + page;
      const response = await send(
        route,
        "POST",
        [...BASE_HEADERS, ...session.headers],
        rpcBody(id, "tools/list", cursor === undefined ? {} : { cursor }),
      );
      if (response.status < 200 || response.status >= 300) {
        response.cancel();
        throw statusError(route, "tools/list", response.status);
      }
      const message = await reply(route, response, id, "tools/list");
      if (Object.hasOwn(message, "error")) {
        throw rpcError("tools/list", message.error);
      }
      const result = mcpToolsListResultSchema.safeParse(message.result);
      if (!result.success) {
        throw refused("The MCP server's tools/list result is not a tool list.");
      }
      tools.push(...result.data.tools);
      if (tools.length > TOOLS_MAX) {
        throw refused(`The MCP server lists more than ${TOOLS_MAX} tools.`);
      }
      cursor = result.data.nextCursor;
      if (cursor === undefined || cursor === "") {
        return { tools, serverVersion: session.serverVersion };
      }
    }
    throw refused(
      `The MCP server's tool list runs past ${TOOLS_PAGES_MAX} pages.`,
    );
  } finally {
    closeSession(route, session);
  }
}

// ── GraphQL introspection ────────────────────────────────────────────────────

/** The standard introspection query, deep enough for seven wrapping types. */
export const INTROSPECTION_QUERY = `query IntrospectionQuery {
  __schema {
    queryType { name }
    mutationType { name }
    subscriptionType { name }
    types { ...FullType }
    directives { name description locations args { ...InputValue } }
  }
}
fragment FullType on __Type {
  kind
  name
  description
  fields(includeDeprecated: true) {
    name
    description
    args { ...InputValue }
    type { ...TypeRef }
    isDeprecated
    deprecationReason
  }
  inputFields { ...InputValue }
  interfaces { ...TypeRef }
  enumValues(includeDeprecated: true) {
    name
    description
    isDeprecated
    deprecationReason
  }
  possibleTypes { ...TypeRef }
}
fragment InputValue on __InputValue {
  name
  description
  type { ...TypeRef }
  defaultValue
}
fragment TypeRef on __Type {
  kind
  name
  ofType { kind name ofType { kind name ofType { kind name ofType {
    kind name ofType { kind name ofType { kind name ofType { kind name } } }
  } } } }
}`;

export interface IntrospectRequest {
  url: string;
  network: string;
  auth: ManifestAuth | null;
  credential: SendCredential;
  transport: Transport;
  scrubber: Scrubber;
  signal: AbortSignal;
  /** The most bytes the answer may hold. */
  maxBytes: number;
  deadlineMs?: number;
}

/** POST the introspection query and return the parsed answer. */
export async function introspectGraphql(
  request: IntrospectRequest,
): Promise<unknown> {
  const placed = placeCredential(
    request.auth,
    request.credential,
    request.scrubber,
  );
  const route = routeOf({ ...request, placed });
  const response = await send(
    route,
    "POST",
    [
      ["Accept", "application/json"],
      ["Content-Type", "application/json"],
    ],
    JSON.stringify({
      query: INTROSPECTION_QUERY,
      operationName: "IntrospectionQuery",
    }),
  );
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw statusError(route, "the introspection query", response.status);
  }
  const bytes = await readBody(route, response, request.maxBytes);
  const parsed = parseJson(new TextDecoder().decode(bytes));
  if (!parsed.ok) {
    throw refused(
      `${route.endpoint.host} answered the introspection query with JSON that does not parse.`,
    );
  }
  return parsed.value;
}

// ── A plain GET ──────────────────────────────────────────────────────────────

export interface FetchTextRequest {
  url: string;
  network: string;
  transport: Transport;
  signal: AbortSignal;
  accept: string;
  /** The most bytes the body may hold. 8 MiB by default. */
  maxBytes?: number;
  deadlineMs?: number;
}

/** GET a url with no credential and return its text. */
export async function fetchText(request: FetchTextRequest): Promise<string> {
  const route = routeOf({
    ...request,
    placed: { headers: [], query: [] },
  });
  const response = await send(route, "GET", [["Accept", request.accept]], "");
  if (response.status < 200 || response.status >= 300) {
    response.cancel();
    throw statusError(route, `GET ${route.path}`, response.status);
  }
  const bytes = await readBody(
    route,
    response,
    request.maxBytes ?? MCP_REPLY_BYTES_MAX,
  );
  return new TextDecoder().decode(bytes);
}
