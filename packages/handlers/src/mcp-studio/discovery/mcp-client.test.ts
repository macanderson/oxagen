// mcp-client.test.ts: the requests discovery sends upstream (lane M10,
// #4682). A fake Transport answers each request from a script, so each case
// checks what mcp-client.ts sends, what it reads, and what it refuses. No
// case touches the network or the global fetch.
import { describe, expect, it, vi, type Mock } from "vitest";
import {
  MCP_PROTOCOL_VERSION,
  TransportError,
  type HeaderEntry,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ManifestAuth,
  type SendCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import {
  fetchText,
  introspectGraphql,
  INTROSPECTION_QUERY,
  listMcpTools,
  MCP_REPLY_BYTES_MAX,
  parseEndpoint,
  placeCredential,
  REQUEST_DEADLINE_MS,
  SseParser,
  TOOLS_MAX,
  TOOLS_PAGES_MAX,
  type FetchTextRequest,
  type IntrospectRequest,
  type McpListRequest,
} from "./mcp-client";
import {
  createScrubber,
  MIN_SECRET_LENGTH,
  REDACTED,
  scrubbedMessage,
} from "./scrub";
import { DiscoveryRefused } from "./types";

const TOKEN = "tok-s3cr3t-9f8e7d";
const API_KEY = "AbC/12+34=";
const API_KEY_ENCODED = "AbC%2F12%2B34%3D";
const PASSWORD = "pa55-w0rd!x";
const SESSION = "session-7f3a";
const HOST = "mcp.billing.example";
const MCP_URL = `https://${HOST}/mcp?region=us`;
const JSON_TYPE: HeaderEntry[] = [["Content-Type", "application/json"]];
const BASE_HEADERS: HeaderEntry[] = [
  ["Accept", "application/json, text/event-stream"],
  ["Content-Type", "application/json"],
];
const BEARER: HeaderEntry = ["Authorization", `Bearer ${TOKEN}`];
const SESSION_HEADERS: HeaderEntry[] = [
  ["Mcp-Session-Id", SESSION],
  ["MCP-Protocol-Version", "2025-03-26"],
];
const INITIALIZE_RESULT = {
  protocolVersion: "2025-03-26",
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: "billing", version: "4.2.0" },
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── The fake upstream ────────────────────────────────────────────────────────

/** How the fake upstream answers one request. */
interface Script {
  status?: number;
  headers?: HeaderEntry[];
  /** The body's chunks, in order. */
  body?: readonly (string | Uint8Array)[];
  /** After the last chunk, the body never ends. */
  hang?: boolean;
  /** After the last chunk, the read rejects with this value. */
  readFails?: unknown;
  /** The transport rejects with this value instead of answering. */
  sendFails?: unknown;
  /** The transport answers nothing and rejects once the signal aborts. */
  hangSend?: boolean;
}

/** One request the transport received, and the cancel of its response. */
interface Sent {
  request: HttpTransportRequest;
  cancel: Mock<() => void>;
}

interface RpcRequest {
  jsonrpc: string;
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

function bodyOf(script: Script): AsyncIterable<Uint8Array> {
  const chunks = (script.body ?? []).map((chunk) =>
    typeof chunk === "string" ? encoder.encode(chunk) : chunk,
  );
  return {
    [Symbol.asyncIterator]() {
      let at = 0;
      return {
        next(): Promise<IteratorResult<Uint8Array>> {
          const chunk = chunks[at];
          at += 1;
          if (chunk !== undefined) {
            return Promise.resolve({ done: false, value: chunk });
          }
          if (script.hang === true) {
            return new Promise<IteratorResult<Uint8Array>>(() => undefined);
          }
          if (script.readFails !== undefined) {
            return Promise.reject(script.readFails);
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  };
}

/** Rejects once the signal aborts, as a transport that honors it does. */
function abortedBy(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    const fail = () =>
      reject(new TransportError("timeout", "The request was aborted.", false));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

function fakeTransport(answer: (request: HttpTransportRequest) => Script) {
  const sent: Sent[] = [];
  const http = vi.fn(
    async (request: HttpTransportRequest): Promise<HttpTransportResponse> => {
      const cancel = vi.fn<() => void>();
      sent.push({ request, cancel });
      const script = answer(request);
      if (script.hangSend === true) return abortedBy(request.signal);
      if (script.sendFails !== undefined) throw script.sendFails;
      return {
        status: script.status ?? 200,
        headers: script.headers ?? [],
        body: bodyOf(script),
        cancel,
      };
    },
  );
  const transport: Transport = {
    http,
    grpc: () => Promise.reject(new Error("Discovery sends no gRPC call.")),
    local: () => Promise.reject(new Error("Discovery runs no local call.")),
  };
  return { transport, http, sent };
}

function rpcOf(request: HttpTransportRequest): RpcRequest | undefined {
  if (request.body.byteLength === 0) return undefined;
  return JSON.parse(decoder.decode(request.body)) as RpcRequest;
}

function json(value: unknown, headers: HeaderEntry[] = []): Script {
  return {
    status: 200,
    headers: [...JSON_TYPE, ...headers],
    body: [JSON.stringify(value)],
  };
}

function sse(
  chunks: readonly (string | Uint8Array)[],
  headers: HeaderEntry[] = [["Content-Type", "text/event-stream"]],
): Script {
  return { status: 200, headers, body: chunks };
}

function result(id: number | undefined, value: unknown): unknown {
  return { jsonrpc: "2.0", id, result: value };
}

function tool(name: string) {
  return { name, inputSchema: { type: "object" } };
}

/**
 * An MCP server that answers initialize with a session id, accepts
 * notifications/initialized, lists one tool, and accepts the DELETE. handle
 * answers first when it returns a script.
 */
function mcpServer(
  handle: (rpc: RpcRequest) => Script | undefined = () => undefined,
  options: { tools?: readonly unknown[]; close?: Script } = {},
): (request: HttpTransportRequest) => Script {
  return (request) => {
    if (request.target.method === "DELETE") {
      return options.close ?? { status: 204 };
    }
    const rpc = rpcOf(request);
    if (rpc === undefined) throw new Error("The fake got a POST with no body.");
    const custom = handle(rpc);
    if (custom !== undefined) return custom;
    switch (rpc.method) {
      case "initialize":
        return json(result(1, INITIALIZE_RESULT), [["Mcp-Session-Id", SESSION]]);
      case "notifications/initialized":
        return { status: 202 };
      case "tools/list":
        return json(
          result(rpc.id, { tools: options.tools ?? [tool("create_refund")] }),
        );
      default:
        throw new Error(`The fake has no answer to ${rpc.method}.`);
    }
  };
}

/** A server whose tools/list page n holds tools(n), with a cursor while more(n). */
function paged(
  tools: (page: number) => unknown[],
  more: (page: number) => boolean,
): (request: HttpTransportRequest) => Script {
  return mcpServer((rpc) => {
    if (rpc.method !== "tools/list") return undefined;
    const page = (rpc.id ?? 0) - 2;
    const cursor = more(page) ? { nextCursor: `page-${page + 1}` } : {};
    return json(result(rpc.id, { tools: tools(page), ...cursor }));
  });
}

/** Answer one method with a script, and every other method as usual. */
function on(method: string, script: Script): (rpc: RpcRequest) => Script | undefined {
  return (rpc) => (rpc.method === method ? script : undefined);
}

function methodsOf(sent: readonly Sent[]): string[] {
  return sent.map(
    ({ request }) => rpcOf(request)?.method ?? request.target.method,
  );
}

function callsOf(sent: readonly Sent[], method: string): Sent[] {
  return sent.filter(({ request }) =>
    method === "DELETE"
      ? request.target.method === "DELETE"
      : rpcOf(request)?.method === method,
  );
}

function nth<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`Nothing at index ${index}.`);
  return item;
}

function onlyCall(sent: readonly Sent[], method: string): Sent {
  return nth(callsOf(sent, method), 0);
}

async function refusalOf(promise: Promise<unknown>): Promise<DiscoveryRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DiscoveryRefused) return error;
    throw error;
  }
  throw new Error("Expected a refusal, and the call succeeded.");
}

function thrownBy(fn: () => unknown): DiscoveryRefused {
  try {
    fn();
  } catch (error) {
    if (error instanceof DiscoveryRefused) return error;
    throw error;
  }
  throw new Error("Expected a refusal, and the call returned.");
}

/** The text's bytes, cut inside its first character of more than one byte. */
function cutInsideCharacter(text: string): [Uint8Array, Uint8Array] {
  const bytes = encoder.encode(text);
  const cut = bytes.findIndex((byte) => byte >= 0x80) + 1;
  if (cut === 0) throw new Error("The text has no character of two bytes.");
  return [bytes.slice(0, cut), bytes.slice(cut)];
}

function apiKeyAuth(apply: ManifestAuth["apply"]): ManifestAuth {
  return { mode: "service", scheme: "billing_key", apply };
}

const QUERY_KEY_AUTH = apiKeyAuth({ type: "api_key", in: "query", name: "key" });

function listRequest(
  transport: Transport,
  overrides: Partial<McpListRequest> = {},
): McpListRequest {
  return {
    url: MCP_URL,
    network: "cloud",
    auth: null,
    credential: { type: "bearer", token: TOKEN },
    transport,
    scrubber: createScrubber(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

// ── parseEndpoint ────────────────────────────────────────────────────────────

describe("parseEndpoint", () => {
  it("reads the scheme, the host, the port, and the path with its query", () => {
    expect(parseEndpoint(MCP_URL)).toEqual({
      scheme: "https",
      host: HOST,
      port: undefined,
      path: "/mcp?region=us",
    });
    expect(parseEndpoint("http://10.0.4.12:8080/mcp")).toEqual({
      scheme: "http",
      host: "10.0.4.12",
      port: 8080,
      path: "/mcp",
    });
  });

  it("lowercases the host and drops the scheme's default port", () => {
    expect(parseEndpoint("https://MCP.Billing.Example:443/")).toEqual({
      scheme: "https",
      host: HOST,
      port: undefined,
      path: "/",
    });
  });

  it.each<[string, string]>([
    ["not a url", "The url not a url does not parse."],
    ["ftp://files.example/tools.json", "A url is https or http, not ftp."],
    ["file:///etc/tools.json", "A url is https or http, not file."],
    [
      `https://${HOST}/mcp#tools`,
      `A url has no fragment: https://${HOST}/mcp#tools.`,
    ],
    [
      "http://[::1]:8080/mcp",
      "An IPv6 host is not supported. Name the host, or use an IPv4 address.",
    ],
    [
      "https://bad_host.example/mcp",
      "bad_host.example is not a host name or an IPv4 address.",
    ],
  ])("refuses %s", (url, message) => {
    const refusal = thrownBy(() => parseEndpoint(url));
    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(message);
  });

  it("refuses a user name or a password in the url and does not repeat it", () => {
    const message =
      "A url cannot carry a user name or password. Store the secret as a credential.";
    const withPassword = thrownBy(() =>
      parseEndpoint(`https://bot:hunter2-secret@${HOST}/mcp`),
    );
    expect(withPassword.code).toBe("source");
    expect(withPassword.message).toBe(message);
    expect(withPassword.message).not.toContain("hunter2-secret");
    expect(thrownBy(() => parseEndpoint(`https://bot@${HOST}/mcp`)).message).toBe(
      message,
    );
  });
});

// ── placeCredential ──────────────────────────────────────────────────────────

describe("placeCredential", () => {
  it("places nothing for a server with no credential", () => {
    expect(placeCredential(null, { type: "none" }, createScrubber())).toEqual({
      headers: [],
      query: [],
    });
  });

  it("refuses a relay credential until discovery can reach a relay", () => {
    const refusal = thrownBy(() =>
      placeCredential(
        null,
        { type: "relay", credential: { name: "billing", scheme: "bearer" } },
        createScrubber(),
      ),
    );
    expect(refusal.code).toBe("unsupported");
    expect(refusal.message).toBe(
      "Discovery through a relay is not available yet.",
    );
  });

  it("puts a bearer token in Authorization and teaches the scrubber the token", () => {
    const scrubber = createScrubber();
    expect(
      placeCredential(null, { type: "bearer", token: TOKEN }, scrubber),
    ).toEqual({ headers: [BEARER], query: [] });
    expect(scrubber.scrub(`echo: Bearer ${TOKEN}`)).toBe(
      `echo: Bearer ${REDACTED}`,
    );
  });

  it("puts a basic pair in Authorization and teaches the scrubber the password and the pair", () => {
    const scrubber = createScrubber();
    const pair = Buffer.from(`billing-bot:${PASSWORD}`, "utf8").toString(
      "base64",
    );
    expect(
      placeCredential(
        null,
        { type: "basic", username: "billing-bot", password: PASSWORD },
        scrubber,
      ),
    ).toEqual({ headers: [["Authorization", `Basic ${pair}`]], query: [] });
    expect(scrubber.scrub(`Basic ${pair} and ${PASSWORD}`)).toBe(
      `Basic ${REDACTED} and ${REDACTED}`,
    );
  });

  it("refuses a colon in a basic user name", () => {
    const refusal = thrownBy(() =>
      placeCredential(
        null,
        { type: "basic", username: "billing:bot", password: PASSWORD },
        createScrubber(),
      ),
    );
    expect(refusal.code).toBe("credential");
    expect(refusal.message).toBe(
      "A basic credential's user name cannot hold a colon (RFC 7617).",
    );
    expect(refusal.message).not.toContain(PASSWORD);
  });

  it("puts an API key in the header the scheme names", () => {
    const scrubber = createScrubber();
    expect(
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "header", name: "X-Api-Key" }),
        { type: "api_key", value: API_KEY },
        scrubber,
      ),
    ).toEqual({ headers: [["X-Api-Key", API_KEY]], query: [] });
    expect(scrubber.scrub(`X-Api-Key: ${API_KEY}`)).toBe(
      `X-Api-Key: ${REDACTED}`,
    );
  });

  it("puts an API key in the query, percent-encoded, and scrubs the encoded form", () => {
    const scrubber = createScrubber();
    expect(
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "query", name: "api key" }),
        { type: "api_key", value: API_KEY },
        scrubber,
      ),
    ).toEqual({ headers: [], query: [`api%20key=${API_KEY_ENCODED}`] });
    expect(scrubber.scrub(`GET /graphql?api%20key=${API_KEY_ENCODED}`)).toBe(
      `GET /graphql?api%20key=${REDACTED}`,
    );
  });

  it("puts an API key in a cookie", () => {
    expect(
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "cookie", name: "session_key" }),
        { type: "api_key", value: "AbC123xyz" },
        createScrubber(),
      ),
    ).toEqual({ headers: [["Cookie", "session_key=AbC123xyz"]], query: [] });
  });

  it.each<[string]>([
    ["abc def"],
    ["abc\tdef"],
    ["abc;def"],
    ["abc,def"],
    ['abc"def'],
    ["abc\\def"],
  ])("refuses a cookie value that holds %j", (value) => {
    const refusal = thrownBy(() =>
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "cookie", name: "session_key" }),
        { type: "api_key", value },
        createScrubber(),
      ),
    );
    expect(refusal.code).toBe("credential");
    expect(refusal.message).toBe(
      "The API key holds a character a cookie cannot carry: a space, a quote, a comma, a semicolon, or a backslash.",
    );
    expect(refusal.message).not.toContain(value);
  });

  it.each<[string, ManifestAuth | null]>([
    ["no auth scheme", null],
    ["a bearer scheme", apiKeyAuth({ type: "http_bearer" })],
    [
      "an api_key scheme with no name",
      apiKeyAuth({ type: "api_key", in: "header" }),
    ],
    [
      "an api_key scheme with no place",
      apiKeyAuth({ type: "api_key", name: "X-Api-Key" }),
    ],
  ])("refuses an API key with %s", (_label, auth) => {
    const refusal = thrownBy(() =>
      placeCredential(auth, { type: "api_key", value: API_KEY }, createScrubber()),
    );
    expect(refusal.code).toBe("credential");
    expect(refusal.message).toBe(
      "An API key needs an api_key auth scheme that names where it goes.",
    );
    expect(refusal.message).not.toContain(API_KEY);
  });

  it.each<[string, SendCredential, string]>([
    [
      "access token",
      { type: "bearer", token: "tok-9f8e\r\nX-Evil: 1" },
      "tok-9f8e",
    ],
    [
      "user name",
      { type: "basic", username: "bot\n", password: PASSWORD },
      PASSWORD,
    ],
    [
      "password",
      { type: "basic", username: "bot", password: "pa55\0w0rd" },
      "w0rd",
    ],
    ["API key", { type: "api_key", value: "AbC\r123" }, "AbC"],
  ])("refuses a line break or a NUL in the %s", (what, credential, secret) => {
    const refusal = thrownBy(() =>
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "header", name: "X-Api-Key" }),
        credential,
        createScrubber(),
      ),
    );
    expect(refusal.code).toBe("credential");
    expect(refusal.message).toBe(
      `The ${what} holds a line break or a NUL, so no request can carry it.`,
    );
    expect(refusal.message).not.toContain(secret);
  });

  it.each<[string, SendCredential]>([
    ["access token", { type: "bearer", token: "t0k" }],
    ["password", { type: "basic", username: "bot", password: "pw1" }],
    ["API key", { type: "api_key", value: "k" }],
  ])("refuses a %s the scrubber is too short to catch", (what, credential) => {
    const refusal = thrownBy(() =>
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "header", name: "X-Api-Key" }),
        credential,
        createScrubber(),
      ),
    );
    expect(refusal.code).toBe("credential");
    expect(refusal.message).toBe(
      `The ${what} is shorter than ${MIN_SECRET_LENGTH} characters, so discovery cannot keep it out of what it writes.`,
    );
  });

  it("places a secret at the scrubber's minimum length and scrubs it", () => {
    const short = "k".repeat(MIN_SECRET_LENGTH);
    const scrubber = createScrubber();
    expect(
      placeCredential(
        apiKeyAuth({ type: "api_key", in: "header", name: "X-Api-Key" }),
        { type: "api_key", value: short },
        scrubber,
      ),
    ).toEqual({ headers: [["X-Api-Key", short]], query: [] });
    expect(scrubber.scrub(`echo ${short}`)).toBe(`echo ${REDACTED}`);
  });

  it("places a short basic user name, since only the password is secret", () => {
    expect(
      placeCredential(
        null,
        { type: "basic", username: "b", password: PASSWORD },
        createScrubber(),
      ).headers,
    ).toHaveLength(1);
  });
});

// ── SseParser ────────────────────────────────────────────────────────────────

describe("SseParser", () => {
  it("joins an event split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("data: hel")).toEqual([]);
    expect(parser.push("lo\n")).toEqual([]);
    expect(parser.push("\n")).toEqual([{ event: "message", data: "hello" }]);
  });

  it("joins data lines with a line break", () => {
    expect(new SseParser().push("data: one\ndata: two\n\n")).toEqual([
      { event: "message", data: "one\ntwo" },
    ]);
  });

  it("names an event and resets the name after it", () => {
    expect(
      new SseParser().push("event: update\ndata: a\n\ndata: b\n\n"),
    ).toEqual([
      { event: "update", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("skips comments and ignores id and retry lines", () => {
    expect(
      new SseParser().push(": ping\nid: 7\nretry: 1000\ndata: x\n\n"),
    ).toEqual([{ event: "message", data: "x" }]);
  });

  it("resets an event name that no data followed", () => {
    expect(new SseParser().push("event: ping\n\ndata: y\n\n")).toEqual([
      { event: "message", data: "y" },
    ]);
  });

  it("reads a field with no colon as an empty value", () => {
    expect(new SseParser().push("data\ndata\n\n")).toEqual([
      { event: "message", data: "\n" },
    ]);
  });

  it("strips one leading space from a value and keeps the rest", () => {
    expect(new SseParser().push("data:  two\ndata:none\n\n")).toEqual([
      { event: "message", data: " two\nnone" },
    ]);
  });

  it("waits for the second half of a CRLF split across chunks", () => {
    const parser = new SseParser();
    expect(parser.push("data: a\r")).toEqual([]);
    expect(parser.push("\ndata: b\r\n\r\n")).toEqual([
      { event: "message", data: "a\nb" },
    ]);
  });

  it("reads CR line endings and flushes a trailing CR at the end", () => {
    const parser = new SseParser();
    expect(parser.push("data: z\r\r")).toEqual([]);
    expect(parser.end()).toEqual([{ event: "message", data: "z" }]);
  });

  it("drops an event with no blank line after it at the end, and starts clean", () => {
    const parser = new SseParser();
    expect(parser.push("event: update\ndata: partial\ndata: tail")).toEqual([]);
    expect(parser.end()).toEqual([]);
    expect(parser.push("data: fresh\n\n")).toEqual([
      { event: "message", data: "fresh" },
    ]);
  });
});

// ── listMcpTools ─────────────────────────────────────────────────────────────

describe("listMcpTools", () => {
  it("opens a session, lists the tools, and ends the session", async () => {
    const { transport, sent } = fakeTransport(mcpServer());

    const listed = await listMcpTools(listRequest(transport));

    expect(listed).toEqual({
      tools: [tool("create_refund")],
      serverVersion: "4.2.0",
    });
    expect(methodsOf(sent)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "DELETE",
    ]);

    const init = onlyCall(sent, "initialize");
    expect(init.request).toMatchObject({
      network: "cloud",
      deadline_ms: REQUEST_DEADLINE_MS,
      relay_credential: undefined,
    });
    expect(init.request.signal).toBeInstanceOf(AbortSignal);
    expect(init.request.target).toEqual({
      kind: "http",
      scheme: "https",
      method: "POST",
      host: HOST,
      port: undefined,
      path: "/mcp?region=us",
    });
    expect(init.request.headers).toEqual([...BASE_HEADERS, BEARER]);
    expect(rpcOf(init.request)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "oxagen-discovery", version: "1" },
      },
    });

    const notify = onlyCall(sent, "notifications/initialized");
    expect(notify.request.headers).toEqual([
      ...BASE_HEADERS,
      ...SESSION_HEADERS,
      BEARER,
    ]);
    expect(rpcOf(notify.request)).toEqual({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const list = onlyCall(sent, "tools/list");
    expect(list.request.headers).toEqual([
      ...BASE_HEADERS,
      ...SESSION_HEADERS,
      BEARER,
    ]);
    expect(rpcOf(list.request)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const close = onlyCall(sent, "DELETE");
    expect(close.request.target).toMatchObject({
      method: "DELETE",
      host: HOST,
      path: "/mcp?region=us",
    });
    expect(close.request.headers).toEqual([...SESSION_HEADERS, BEARER]);
    expect(close.request.body.byteLength).toBe(0);
    expect(close.request.deadline_ms).toBe(5000);
    await vi.waitFor(() => expect(close.cancel).toHaveBeenCalledTimes(1));

    // Each JSON reply was read to its end, so none was cancelled.
    expect(init.cancel).not.toHaveBeenCalled();
    expect(notify.cancel).not.toHaveBeenCalled();
    expect(list.cancel).not.toHaveBeenCalled();
  });

  it("reads a response from an event stream and stops reading once it arrives", async () => {
    const description = "Refund a café order.";
    const [head, tail] = cutInsideCharacter(
      `data: ${JSON.stringify(
        result(2, { tools: [{ ...tool("create_refund"), description }] }),
      )}\n\n`,
    );
    const stream = sse(
      [
        ": ping\n\n",
        "event: endpoint\ndata: /messages\n\n",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sampling/createMessage", params: {} })}\n\n`,
        `data: ${JSON.stringify(result(99, { tools: [] }))}\n\n`,
        "data: not json\n\n",
        head,
        tail,
        "data: never read\n\n",
      ],
      [["content-type", "Text/Event-Stream; charset=utf-8"]],
    );
    const { transport, sent } = fakeTransport(
      mcpServer(on("tools/list", stream)),
    );

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.tools).toEqual([{ ...tool("create_refund"), description }]);
    expect(onlyCall(sent, "tools/list").cancel).toHaveBeenCalledTimes(1);
  });

  it("finds a response that only the end of the stream completes", async () => {
    const stream = sse(
      [`data: ${JSON.stringify(result(1, INITIALIZE_RESULT))}\n\r`],
      [
        ["Content-Type", "text/event-stream"],
        ["Mcp-Session-Id", SESSION],
      ],
    );
    const { transport, sent } = fakeTransport(
      mcpServer(on("initialize", stream)),
    );

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.serverVersion).toBe("4.2.0");
    expect(onlyCall(sent, "initialize").cancel).not.toHaveBeenCalled();
    expect(callsOf(sent, "DELETE")).toHaveLength(1);
  });

  it("refuses an event stream that ends with no response and still ends the session", async () => {
    // The last event has no blank line after it, so the parser drops it.
    const stream = sse([
      ": keepalive\n\n",
      `data: ${JSON.stringify(result(2, { tools: [] }))}`,
    ]);
    const { transport, sent } = fakeTransport(
      mcpServer(on("tools/list", stream)),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(
      "The MCP server's event stream ended with no response to tools/list.",
    );
    expect(onlyCall(sent, "tools/list").cancel).not.toHaveBeenCalled();
    expect(callsOf(sent, "DELETE")).toHaveLength(1);
  });

  it.each<[string, unknown, string]>([
    ["a date", "2025-03-26", "2025-03-26"],
    ["a word", "latest", MCP_PROTOCOL_VERSION],
    ["nothing", undefined, MCP_PROTOCOL_VERSION],
  ])(
    "sends the protocol version the server named when it names %s",
    async (_label, protocolVersion, sentVersion) => {
      const initialize = json(
        result(1, { ...INITIALIZE_RESULT, protocolVersion }),
        [["Mcp-Session-Id", SESSION]],
      );
      const { transport, sent } = fakeTransport(
        mcpServer(on("initialize", initialize)),
      );

      await listMcpTools(listRequest(transport));

      expect(onlyCall(sent, "tools/list").request.headers).toContainEqual([
        "MCP-Protocol-Version",
        sentVersion,
      ]);
    },
  );

  it.each<[string, unknown, string | undefined]>([
    ["a version of 64 characters", { version: "v".repeat(64) }, "v".repeat(64)],
    ["a version of 65 characters", { version: "v".repeat(65) }, undefined],
    ["an empty version", { version: "" }, undefined],
    ["a version that is a number", { version: 4 }, undefined],
    ["no server info", undefined, undefined],
  ])(
    "keeps the server version only when it fits a lock, given %s",
    async (_label, serverInfo, serverVersion) => {
      const initialize = json(result(1, { ...INITIALIZE_RESULT, serverInfo }));
      const { transport } = fakeTransport(
        mcpServer(on("initialize", initialize)),
      );

      const listed = await listMcpTools(listRequest(transport));

      expect(listed.serverVersion).toBe(serverVersion);
    },
  );

  it("sends no session id and no DELETE when the server gave no session", async () => {
    const initialize = json(result(1, INITIALIZE_RESULT));
    const { transport, sent } = fakeTransport(
      mcpServer(on("initialize", initialize)),
    );

    await listMcpTools(listRequest(transport));

    expect(methodsOf(sent)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(onlyCall(sent, "tools/list").request.headers).toEqual([
      ...BASE_HEADERS,
      ["MCP-Protocol-Version", "2025-03-26"],
      BEARER,
    ]);
  });

  it("follows nextCursor until the server gives none", async () => {
    const pages = [
      { tools: [tool("a")], nextCursor: "c1" },
      { tools: [tool("b"), tool("c")], nextCursor: "c2" },
      { tools: [tool("d")], nextCursor: "" },
    ];
    const { transport, sent } = fakeTransport(
      mcpServer((rpc) =>
        rpc.method === "tools/list"
          ? json(result(rpc.id, nth(pages, (rpc.id ?? 0) - 2)))
          : undefined,
      ),
    );

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.tools.map((item) => item.name)).toEqual(["a", "b", "c", "d"]);
    expect(
      callsOf(sent, "tools/list").map(({ request }) => {
        const rpc = rpcOf(request);
        return [rpc?.id, rpc?.params];
      }),
    ).toEqual([
      [2, {}],
      [3, { cursor: "c1" }],
      [4, { cursor: "c2" }],
    ]);
  });

  it("reads as many as 50 pages", async () => {
    const { transport, sent } = fakeTransport(
      paged(
        (page) => [tool(`tool_${page}`)],
        (page) => page < TOOLS_PAGES_MAX - 1,
      ),
    );

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.tools).toHaveLength(TOOLS_PAGES_MAX);
    expect(callsOf(sent, "tools/list")).toHaveLength(TOOLS_PAGES_MAX);
  });

  it("refuses a tool list that runs past 50 pages and ends the session", async () => {
    const { transport, sent } = fakeTransport(
      paged(
        (page) => [tool(`tool_${page}`)],
        () => true,
      ),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      "The MCP server's tool list runs past 50 pages.",
    );
    expect(callsOf(sent, "tools/list")).toHaveLength(TOOLS_PAGES_MAX);
    expect(callsOf(sent, "DELETE")).toHaveLength(1);
  });

  it("accepts 2000 tools across pages and refuses one more", async () => {
    const half = TOOLS_MAX / 2;
    const tools = (extra: number) => (page: number) =>
      Array.from({ length: page === 0 ? half : half + extra }, (_item, index) =>
        tool(`tool_${page}_${index}`),
      );

    const full = fakeTransport(paged(tools(0), (page) => page === 0));
    const listed = await listMcpTools(listRequest(full.transport));
    expect(listed.tools).toHaveLength(TOOLS_MAX);

    const over = fakeTransport(paged(tools(1), (page) => page === 0));
    const refusal = await refusalOf(listMcpTools(listRequest(over.transport)));
    expect(refusal.message).toBe("The MCP server lists more than 2000 tools.");
  });

  it("refuses a reply over the byte limit and cancels it", async () => {
    const oversize: Script = {
      status: 200,
      headers: JSON_TYPE,
      body: [new Uint8Array(MCP_REPLY_BYTES_MAX), new Uint8Array(1)],
    };
    const { transport, sent } = fakeTransport(
      mcpServer(on("tools/list", oversize)),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      `${HOST} sent more than ${MCP_REPLY_BYTES_MAX} bytes in one reply.`,
    );
    expect(onlyCall(sent, "tools/list").cancel).toHaveBeenCalledTimes(1);
  });

  it.each<[string, unknown, string]>([
    [
      "initialize",
      { code: -32602, message: "Unsupported protocol version" },
      "The MCP server refused initialize: Unsupported protocol version (code -32602)",
    ],
    [
      "tools/list",
      { code: "E_RATE", message: "Rate limited" },
      "The MCP server refused tools/list: Rate limited",
    ],
    ["tools/list", null, "The MCP server refused tools/list: no message"],
  ])("refuses a JSON-RPC error to %s", async (method, error, message) => {
    const { transport } = fakeTransport(
      mcpServer((rpc) =>
        rpc.method === method
          ? json({ jsonrpc: "2.0", id: rpc.id, error })
          : undefined,
      ),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(message);
  });

  it.each<[string]>([
    ["initialize"],
    ["notifications/initialized"],
    ["tools/list"],
  ])("refuses an HTTP error status to %s and cancels it", async (method) => {
    const { transport, sent } = fakeTransport(
      mcpServer(on(method, { status: 503, body: ["Service Unavailable"] })),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(`${HOST} answered ${method} with HTTP 503.`);
    expect(onlyCall(sent, method).cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a session id that is not visible ASCII and cancels the reply", async () => {
    const initialize = json(result(1, INITIALIZE_RESULT), [
      ["Mcp-Session-Id", "bad id"],
    ]);
    const { transport, sent } = fakeTransport(
      mcpServer(on("initialize", initialize)),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      "The MCP server's Mcp-Session-Id is not visible ASCII.",
    );
    expect(onlyCall(sent, "initialize").cancel).toHaveBeenCalledTimes(1);
    expect(methodsOf(sent)).toEqual(["initialize"]);
  });

  it("refuses an initialize result that is not an object", async () => {
    const { transport } = fakeTransport(
      mcpServer(on("initialize", json(result(1, "ready")))),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      "The MCP server's initialize result is not an object.",
    );
  });

  it("ends a session the server opened before initialize failed", async () => {
    const { transport, sent } = fakeTransport(
      mcpServer(
        on("initialize", json(result(1, "ready"), [["Mcp-Session-Id", SESSION]])),
      ),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      "The MCP server's initialize result is not an object.",
    );
    await vi.waitFor(() => expect(callsOf(sent, "DELETE")).toHaveLength(1));
    expect(onlyCall(sent, "DELETE").request.headers).toContainEqual([
      "Mcp-Session-Id",
      SESSION,
    ]);
  });

  it.each<[string, unknown]>([
    [
      "a tool with no name",
      { tools: [{ name: "", inputSchema: { type: "object" } }] },
    ],
    ["no result", undefined],
  ])("refuses a tools/list result with %s", async (_label, value) => {
    const { transport } = fakeTransport(
      mcpServer((rpc) =>
        rpc.method === "tools/list" ? json(result(rpc.id, value)) : undefined,
      ),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(
      "The MCP server's tools/list result is not a tool list.",
    );
  });

  it.each<[string, Script, string]>([
    [
      "no body",
      { status: 200, headers: JSON_TYPE, body: [] },
      "The MCP server answered tools/list with no body.",
    ],
    [
      "JSON that does not parse",
      { status: 200, headers: JSON_TYPE, body: ["{"] },
      "The MCP server answered tools/list with JSON that does not parse.",
    ],
    [
      "a response to another id",
      json(result(99, { tools: [] })),
      "The MCP server's answer holds no response to tools/list.",
    ],
  ])("refuses a JSON reply with %s", async (_label, script, message) => {
    const { transport, sent } = fakeTransport(
      mcpServer(on("tools/list", script)),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(message);
    // The read reached the end of the body, so nothing was cancelled.
    expect(onlyCall(sent, "tools/list").cancel).not.toHaveBeenCalled();
  });

  it("finds its response in a batch and skips notifications and requests", async () => {
    const batch = json([
      { jsonrpc: "2.0", method: "notifications/message", params: {} },
      { jsonrpc: "2.0", id: 2, method: "sampling/createMessage", params: {} },
      result(2, { tools: [tool("create_refund")] }),
    ]);
    const { transport } = fakeTransport(mcpServer(on("tools/list", batch)));

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.tools).toEqual([tool("create_refund")]);
  });

  it("puts an API key in the query of every request, the DELETE included", async () => {
    const scrubber = createScrubber();
    const { transport, sent } = fakeTransport(mcpServer());

    await listMcpTools(
      listRequest(transport, {
        url: `https://${HOST}/mcp`,
        auth: QUERY_KEY_AUTH,
        credential: { type: "api_key", value: API_KEY },
        scrubber,
      }),
    );

    const paths = sent.map(({ request }) => request.target.path);
    expect(paths).toEqual(
      Array.from({ length: 4 }, () => `/mcp?key=${API_KEY_ENCODED}`),
    );
    for (const { request } of sent) {
      expect(request.headers.map(([name]) => name)).not.toContain(
        "Authorization",
      );
    }
    expect(scrubber.scrub(nth(paths, 0))).toBe(`/mcp?key=${REDACTED}`);
  });

  it("refuses a relay network before any request", async () => {
    const { transport, http } = fakeTransport(mcpServer());

    const refusal = await refusalOf(
      listMcpTools(listRequest(transport, { network: "relay:office" })),
    );

    expect(refusal.code).toBe("unsupported");
    expect(refusal.message).toBe(
      "Discovery through a relay is not available yet.",
    );
    expect(http).not.toHaveBeenCalled();
  });

  it.each<[string, SendCredential]>([
    [
      "a relay credential",
      { type: "relay", credential: { name: "billing", scheme: "bearer" } },
    ],
    ["a token with a line break", { type: "bearer", token: "tok\r\nX: 1" }],
  ])("refuses %s before any request", async (_label, credential) => {
    const { transport, http } = fakeTransport(mcpServer());

    const refusal = await refusalOf(
      listMcpTools(listRequest(transport, { credential })),
    );

    expect(refusal).toBeInstanceOf(DiscoveryRefused);
    expect(http).not.toHaveBeenCalled();
  });

  it("ignores a DELETE that fails", async () => {
    const { transport, sent } = fakeTransport(
      mcpServer(undefined, {
        close: {
          sendFails: new TransportError(
            "disconnected",
            "The connection closed.",
            true,
          ),
        },
      }),
    );

    const listed = await listMcpTools(listRequest(transport));

    expect(listed.tools).toEqual([tool("create_refund")]);
    expect(callsOf(sent, "DELETE")).toHaveLength(1);
  });

  it.each<[string, unknown, string]>([
    [
      "a transport error",
      new TransportError(
        "refused_address",
        `${HOST} resolves to a private address.`,
        false,
      ),
      `The request to ${HOST} failed: ${HOST} resolves to a private address.`,
    ],
    [
      "an error",
      new Error("socket hang up"),
      `The request to ${HOST} failed: socket hang up`,
    ],
    ["a string", "ECONNRESET", `The request to ${HOST} failed: ECONNRESET`],
  ])("refuses a send that rejects with %s", async (_label, error, message) => {
    const { transport } = fakeTransport(
      mcpServer(on("initialize", { sendFails: error })),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(message);
  });

  it("refuses a body read that rejects and cancels the reply", async () => {
    const broken: Script = {
      status: 200,
      headers: JSON_TYPE,
      body: ['{"jsonrpc":'],
      readFails: "stream reset",
    };
    const { transport, sent } = fakeTransport(
      mcpServer(on("tools/list", broken)),
    );

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).toBe(`The request to ${HOST} failed: stream reset`);
    expect(onlyCall(sent, "tools/list").cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a reply that outlasts the deadline and cancels it", async () => {
    const { transport, sent } = fakeTransport(
      mcpServer(
        on("tools/list", { status: 200, headers: JSON_TYPE, hang: true }),
      ),
    );

    const refusal = await refusalOf(
      listMcpTools(listRequest(transport, { deadlineMs: 50 })),
    );

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(`${HOST} did not answer within 0.05 seconds.`);
    expect(onlyCall(sent, "tools/list").cancel).toHaveBeenCalledTimes(1);
    expect(
      sent
        .filter(({ request }) => request.target.method === "POST")
        .map(({ request }) => request.deadline_ms),
    ).toEqual([50, 50, 50]);
    expect(onlyCall(sent, "DELETE").request.deadline_ms).toBe(5000);
  });

  it("stops reading when the caller aborts", async () => {
    const controller = new AbortController();
    const { transport, sent } = fakeTransport(
      mcpServer(
        on("tools/list", { status: 200, headers: JSON_TYPE, hang: true }),
      ),
    );
    const pending = listMcpTools(
      listRequest(transport, { signal: controller.signal }),
    );
    await vi.waitFor(() =>
      expect(callsOf(sent, "tools/list")).toHaveLength(1),
    );

    controller.abort();
    const refusal = await refusalOf(pending);

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(
      `The discovery run ended before ${HOST} answered.`,
    );
    expect(onlyCall(sent, "tools/list").cancel).toHaveBeenCalledTimes(1);
  });
});

// ── A credential in a refusal ────────────────────────────────────────────────

describe("a credential in a refusal", () => {
  it.each<[string, (rpc: RpcRequest) => Script | undefined]>([
    ["an error status", on("tools/list", { status: 401 })],
    [
      "a bad session id",
      on(
        "initialize",
        json(result(1, INITIALIZE_RESULT), [["Mcp-Session-Id", "bad id"]]),
      ),
    ],
    [
      "a JSON-RPC error",
      on("tools/list", json({ jsonrpc: "2.0", id: 2, error: { code: -32001 } })),
    ],
    ["an invalid tool list", on("tools/list", json(result(2, { tools: 3 })))],
    ["a reply to another id", on("tools/list", json(result(7, {})))],
    ["a stream with no response", on("tools/list", sse([": ping\n\n"]))],
    [
      "a send that rejects",
      on("tools/list", {
        sendFails: new TransportError(
          "disconnected",
          "The peer reset the stream.",
          true,
        ),
      }),
    ],
  ])("keeps the token out of a refusal for %s", async (_label, handle) => {
    const { transport } = fakeTransport(mcpServer(handle));

    const refusal = await refusalOf(listMcpTools(listRequest(transport)));

    expect(refusal.message).not.toContain(TOKEN);
    expect(refusal.message).not.toContain(
      Buffer.from(TOKEN, "utf8").toString("base64"),
    );
  });

  const pair = Buffer.from(`billing-bot:${PASSWORD}`, "utf8").toString("base64");

  it.each<[string, SendCredential, ManifestAuth | null, string, string]>([
    [
      "a bearer token",
      { type: "bearer", token: TOKEN },
      null,
      `Authorization: Bearer ${TOKEN}`,
      TOKEN,
    ],
    [
      "a basic pair",
      { type: "basic", username: "billing-bot", password: PASSWORD },
      null,
      `Authorization: Basic ${pair}`,
      pair,
    ],
    [
      "an API key in the query",
      { type: "api_key", value: API_KEY },
      QUERY_KEY_AUTH,
      `POST /mcp?region=us&key=${API_KEY_ENCODED}`,
      API_KEY_ENCODED,
    ],
  ])(
    "scrubs %s that the transport echoes into its error",
    async (_label, credential, auth, echo, secret) => {
      const scrubber = createScrubber();
      const { transport } = fakeTransport(
        mcpServer(
          on("initialize", {
            sendFails: new TransportError(
              "refused_host",
              `The upstream refused ${echo}.`,
              true,
            ),
          }),
        ),
      );

      const refusal = await refusalOf(
        listMcpTools(listRequest(transport, { credential, auth, scrubber })),
      );
      const clean = scrubbedMessage(scrubber, refusal);

      expect(clean).toContain(REDACTED);
      expect(clean).not.toContain(secret);
      // The client scrubs its own refusal, so no caller has to.
      expect(refusal.message).not.toContain(secret);
    },
  );

  it("scrubs a token that the server echoes in a JSON-RPC error", async () => {
    const scrubber = createScrubber();
    const { transport } = fakeTransport(
      mcpServer((rpc) =>
        rpc.method === "tools/list"
          ? json({
              jsonrpc: "2.0",
              id: rpc.id,
              error: { code: -32001, message: `Token ${TOKEN} has expired.` },
            })
          : undefined,
      ),
    );

    const refusal = await refusalOf(
      listMcpTools(listRequest(transport, { scrubber })),
    );

    expect(scrubbedMessage(scrubber, refusal)).toBe(
      `The MCP server refused tools/list: Token ${REDACTED} has expired. (code -32001)`,
    );
    expect(refusal.message).toBe(
      `The MCP server refused tools/list: Token ${REDACTED} has expired. (code -32001)`,
    );
  });
});

// ── introspectGraphql ────────────────────────────────────────────────────────

describe("introspectGraphql", () => {
  function introspectRequest(
    transport: Transport,
    overrides: Partial<IntrospectRequest> = {},
  ): IntrospectRequest {
    return {
      url: "https://api.shop.example/graphql?v=2",
      network: "cloud",
      auth: apiKeyAuth({ type: "api_key", in: "query", name: "api_key" }),
      credential: { type: "api_key", value: API_KEY },
      transport,
      scrubber: createScrubber(),
      signal: new AbortController().signal,
      maxBytes: 16,
      ...overrides,
    };
  }

  it("posts the introspection query and returns the parsed answer", async () => {
    const answer = { data: { __schema: { queryType: { name: "Query" } } } };
    const text = JSON.stringify(answer);
    const { transport, sent } = fakeTransport(() => ({
      status: 200,
      headers: JSON_TYPE,
      body: [text.slice(0, 20), text.slice(20)],
    }));

    const parsed = await introspectGraphql(
      introspectRequest(transport, { maxBytes: 1_000_000 }),
    );

    expect(parsed).toEqual(answer);
    const { request, cancel } = nth(sent, 0);
    expect(sent).toHaveLength(1);
    expect(request.target).toEqual({
      kind: "http",
      scheme: "https",
      method: "POST",
      host: "api.shop.example",
      port: undefined,
      path: `/graphql?v=2&api_key=${API_KEY_ENCODED}`,
    });
    expect(request.headers).toEqual([
      ["Accept", "application/json"],
      ["Content-Type", "application/json"],
    ]);
    expect(JSON.parse(decoder.decode(request.body)) as unknown).toEqual({
      query: INTROSPECTION_QUERY,
      operationName: "IntrospectionQuery",
    });
    expect(request.deadline_ms).toBe(REQUEST_DEADLINE_MS);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("returns a GraphQL error answer as it is, and puts a bearer token in Authorization", async () => {
    const answer = { errors: [{ message: "Introspection is disabled." }] };
    const { transport, sent } = fakeTransport(() => json(answer));

    const parsed = await introspectGraphql(
      introspectRequest(transport, {
        auth: null,
        credential: { type: "bearer", token: TOKEN },
        maxBytes: 1_000_000,
      }),
    );

    expect(parsed).toEqual(answer);
    expect(nth(sent, 0).request.headers).toContainEqual(BEARER);
    expect(nth(sent, 0).request.target.path).toBe("/graphql?v=2");
  });

  it.each<[string, Script, string, boolean]>([
    [
      "an error status",
      { status: 400, body: ["Bad Request"] },
      "api.shop.example answered the introspection query with HTTP 400.",
      true,
    ],
    [
      "JSON that does not parse",
      { status: 200, body: ["<html>"] },
      "api.shop.example answered the introspection query with JSON that does not parse.",
      false,
    ],
    [
      "more bytes than maxBytes",
      { status: 200, body: ["x".repeat(17)] },
      "api.shop.example sent more than 16 bytes in one reply.",
      true,
    ],
    [
      "a send that rejects",
      {
        sendFails: new TransportError(
          "refused_redirect",
          "The server redirected to another host.",
          true,
        ),
      },
      "The request to api.shop.example failed: The server redirected to another host.",
      false,
    ],
  ])("refuses %s", async (_label, script, message, cancelled) => {
    const { transport, sent } = fakeTransport(() => script);

    const refusal = await refusalOf(
      introspectGraphql(introspectRequest(transport)),
    );

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(message);
    expect(refusal.message).not.toContain(API_KEY_ENCODED);
    expect(nth(sent, 0).cancel).toHaveBeenCalledTimes(cancelled ? 1 : 0);
  });

  it("refuses a relay network before any request", async () => {
    const { transport, http } = fakeTransport(() => json({}));

    const refusal = await refusalOf(
      introspectGraphql(
        introspectRequest(transport, { network: "relay:office" }),
      ),
    );

    expect(refusal.code).toBe("unsupported");
    expect(http).not.toHaveBeenCalled();
  });
});

// ── fetchText ────────────────────────────────────────────────────────────────

describe("fetchText", () => {
  const REGISTRY_URL = "https://registry.example/v0/servers/billing?version=latest";

  function fetchRequest(
    transport: Transport,
    overrides: Partial<FetchTextRequest> = {},
  ): FetchTextRequest {
    return {
      url: REGISTRY_URL,
      network: "cloud",
      transport,
      signal: new AbortController().signal,
      accept: "application/json",
      ...overrides,
    };
  }

  it("sends a GET with only an Accept header and decodes the text", async () => {
    const text = '{"name":"café"}';
    const { transport, sent } = fakeTransport(() => ({
      status: 200,
      body: cutInsideCharacter(text),
    }));

    expect(await fetchText(fetchRequest(transport))).toBe(text);

    const { request, cancel } = nth(sent, 0);
    expect(request).toMatchObject({
      network: "cloud",
      deadline_ms: REQUEST_DEADLINE_MS,
      relay_credential: undefined,
    });
    expect(request.target).toEqual({
      kind: "http",
      scheme: "https",
      method: "GET",
      host: "registry.example",
      port: undefined,
      path: "/v0/servers/billing?version=latest",
    });
    expect(request.headers).toEqual([["Accept", "application/json"]]);
    expect(request.body.byteLength).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("uses the caller's deadline", async () => {
    const { transport, sent } = fakeTransport(() => ({ hangSend: true }));

    const refusal = await refusalOf(
      fetchText(fetchRequest(transport, { deadlineMs: 20 })),
    );

    expect(refusal.message).toBe(
      "registry.example did not answer within 0.02 seconds.",
    );
    expect(nth(sent, 0).request.deadline_ms).toBe(20);
  });

  it("refuses a body over maxBytes and cancels it", async () => {
    const { transport, sent } = fakeTransport(() => ({
      status: 200,
      body: ["12345", "6789", "never read"],
    }));

    const refusal = await refusalOf(
      fetchText(fetchRequest(transport, { maxBytes: 8 })),
    );

    expect(refusal.message).toBe(
      "registry.example sent more than 8 bytes in one reply.",
    );
    expect(nth(sent, 0).cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses an error status with the path it asked for, and cancels the reply", async () => {
    const { transport, sent } = fakeTransport(() => ({
      status: 404,
      body: ["Not Found"],
    }));

    const refusal = await refusalOf(fetchText(fetchRequest(transport)));

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(
      "registry.example answered GET /v0/servers/billing?version=latest with HTTP 404.",
    );
    expect(nth(sent, 0).cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a send that rejects", async () => {
    const { transport } = fakeTransport(() => ({
      sendFails: new TransportError(
        "refused_host",
        "registry.example is not on the allow list.",
        false,
      ),
    }));

    const refusal = await refusalOf(fetchText(fetchRequest(transport)));

    expect(refusal.message).toBe(
      "The request to registry.example failed: registry.example is not on the allow list.",
    );
  });

  it("refuses a relay network before any request", async () => {
    const { transport, http } = fakeTransport(() => ({ status: 200 }));

    const refusal = await refusalOf(
      fetchText(fetchRequest(transport, { network: "relay:office" })),
    );

    expect(refusal.code).toBe("unsupported");
    expect(http).not.toHaveBeenCalled();
  });

  it("refuses a path no request can carry before any request", async () => {
    const { transport, http } = fakeTransport(() => ({ status: 200 }));

    const refusal = await refusalOf(
      fetchText(
        fetchRequest(transport, {
          url: `https://registry.example/${"a".repeat(8200)}`,
        }),
      ),
    );

    expect(refusal.code).toBe("source");
    expect(refusal.message).toBe(
      "The request to registry.example has a path no request can carry.",
    );
    expect(http).not.toHaveBeenCalled();
  });
});
