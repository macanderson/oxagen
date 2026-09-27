// mcp.ts: one streamable HTTP session per call, its retry rule, how a reply
// becomes a tools/call result, and the local route. A fake Transport plays
// the server, so each case is exact.
import { describe, expect, it } from "vitest";
import type { ManifestAuth, ManifestServer, ManifestTool } from "../contract/manifest";
import { recordedExchangeSchema } from "../contract/tests-files";
import type { McpRequest } from "../model/upstream-tool";
import {
  bodyJson,
  eventStream,
  fakeHttp,
  hanging,
  header,
  initialized,
  mcpManifestServer,
  mcpMethod,
  mcpServer,
  REMOTE_MCP,
  reply,
  rpcFailure,
  rpcReply,
  sendContext,
  SESSION_ID,
  streamed,
  type ContextOptions,
  type FakeResponse,
  type McpScript,
} from "./__tests__/fake-http";
import { encodeText } from "./body";
import { createMcpSender, MCP_PROTOCOL_VERSION, sendLocal } from "./mcp";
import type { SendError, SendResult } from "./sender";
import {
  TransportError,
  type CallToolResult,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type LocalCall,
} from "./transport";

const sender = createMcpSender({ backoff_ms: () => 1 });
const READ_FILE: McpRequest = { kind: "mcp", tool: "read_file" };
const ARGS = { path: "/etc/hosts" };
const OK_RESULT = { content: [{ type: "text", text: "ok" }] };

async function send(
  script: McpScript,
  options: Omit<ContextOptions, "transport"> = {},
): Promise<{ result: SendResult; requests: HttpTransportRequest[] }> {
  const fake = fakeHttp(mcpServer(script));
  const result = await sender.send(
    READ_FILE,
    ARGS,
    sendContext({ transport: fake.transport, url: "https://mcp.example.com/mcp", server: REMOTE_MCP, ...options }),
  );
  return { result, requests: fake.requests };
}

function methods(requests: readonly HttpTransportRequest[]): string[] {
  return requests.map(mcpMethod);
}

function failure(result: SendResult, title: string): SendError {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failure");
  expect(result.error.title).toBe(title);
  return result.error;
}

function success(result: SendResult): unknown {
  if (!result.ok) throw new Error(`expected a success, got ${result.error.title}: ${result.error.detail}`);
  return result.value;
}

/** A counter the script closes over: answers `first` on call 1 and `then` after. */
function onceThen(first: () => HttpTransportResponse, then: () => HttpTransportResponse): () => HttpTransportResponse {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1 ? first() : then();
  };
}

const busy = (status: number, headers: Array<[string, string]> = []): FakeResponse => reply(status, { title: "Busy" }, headers);
const never = (): Promise<HttpTransportResponse> => new Promise(() => undefined);
const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("the session", () => {
  it("initializes, notifies, calls, and ends the session", async () => {
    const { result, requests } = await send({});
    expect(success(result)).toEqual(OK_RESULT);
    expect(result.attempts).toBe(1);
    expect(methods(requests)).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);

    const [init, notify, call, close] = requests;
    if (init === undefined || notify === undefined || call === undefined || close === undefined) throw new Error("four requests");
    expect(init.target).toEqual({ kind: "http", scheme: "https", method: "POST", host: "mcp.example.com", port: undefined, path: "/mcp" });
    expect(init.headers).toEqual([
      ["Accept", "application/json, text/event-stream"],
      ["Content-Type", "application/json"],
    ]);
    expect(bodyJson(init)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "oxagen-gateway", version: "1" } },
    });
    expect(bodyJson(notify)).toEqual({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(bodyJson(call)).toEqual({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: ARGS } });
    for (const request of [notify, call]) {
      expect(header(request, "mcp-session-id")).toBe(SESSION_ID);
      expect(header(request, "mcp-protocol-version")).toBe("2025-06-18");
    }
    expect(close.target.method).toBe("DELETE");
    expect(close.target.path).toBe("/mcp");
    expect(close.headers).toEqual([
      ["Mcp-Session-Id", SESSION_ID],
      ["MCP-Protocol-Version", "2025-06-18"],
    ]);
    expect(close.body.byteLength).toBe(0);
    expect(close.deadline_ms).toBe(5_000);
    expect(close.signal.aborted).toBe(false);
  });

  it("uses the protocol version the server chose, and the default when it names none", async () => {
    const chosen = await send({ initialize: () => initialized("2025-03-26") });
    expect(header(chosen.requests[2] as HttpTransportRequest, "mcp-protocol-version")).toBe("2025-03-26");
    const garbled = await send({ initialize: () => initialized("latest") });
    expect(header(garbled.requests[2] as HttpTransportRequest, "mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
  });

  it("sends no session header and no DELETE when the server assigns no session", async () => {
    const { result, requests } = await send({ initialize: () => initialized(MCP_PROTOCOL_VERSION, []) });
    success(result);
    expect(methods(requests)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
    expect(requests.map((r) => header(r, "mcp-session-id"))).toEqual([undefined, undefined, undefined]);
    expect(header(requests[2] as HttpTransportRequest, "mcp-protocol-version")).toBe(MCP_PROTOCOL_VERSION);
  });

  it("refuses a session id that is not visible ASCII", async () => {
    const answer = initialized(MCP_PROTOCOL_VERSION, [["Mcp-Session-Id", "bad id"]]);
    const { result, requests } = await send({ initialize: () => answer });
    expect(failure(result, "Invalid response")).toMatchObject({ detail: "The MCP server's Mcp-Session-Id is not visible ASCII.", status: 200 });
    expect(answer.cancel).toHaveBeenCalled();
    expect(methods(requests)).toEqual(["initialize"]);
    expect(result.attempts).toBe(1);
  });

  it("releases the DELETE's response, and ignores a DELETE that fails", async () => {
    const closed = reply(204);
    success((await send({ close: () => closed })).result);
    await tick();
    expect(closed.cancel).toHaveBeenCalled();
    success((await send({ close: () => Promise.reject(new Error("gone")) })).result);
    success(
      (
        await send({
          close: () => {
            throw new Error("gone");
          },
        })
      ).result,
    );
    await tick();
  });
});

describe("the reply", () => {
  it("reads a batch that holds the response", async () => {
    const { result } = await send({
      call: () => reply(200, [{ jsonrpc: "2.0", method: "notifications/message", params: {} }, { jsonrpc: "2.0", id: 2, result: OK_RESULT }]),
    });
    expect(success(result)).toEqual(OK_RESULT);
  });

  it("reads an event stream past notifications, server requests, and other events, then stops reading", async () => {
    const stream = streamed(
      200,
      [
        "event: ping\ndata: {}\n\n",
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
        `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "sampling/createMessage", params: {} })}\n\n`,
        "data: not json\n\n",
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "streamed" }] } })}\n\n`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message" })}\n\n`,
      ],
      [["Content-Type", "text/event-stream; charset=utf-8"]],
    );
    const { result } = await send({ call: () => stream });
    expect(success(result)).toEqual({ content: [{ type: "text", text: "streamed" }] });
    expect(stream.cancel).toHaveBeenCalled();
  });

  it("reads initialize as an event stream too", async () => {
    const { result, requests } = await send({
      initialize: () =>
        eventStream([{ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26" } }], [["Mcp-Session-Id", SESSION_ID]]),
    });
    success(result);
    expect(header(requests[2] as HttpTransportRequest, "mcp-protocol-version")).toBe("2025-03-26");
  });

  it("decodes a character split across chunks, and an event the stream's end completes", async () => {
    const bytes = encodeText(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "café" }] } })}\n\r`);
    const cut = bytes.indexOf(0xc3) + 1;
    const split: HttpTransportResponse = {
      status: 200,
      headers: [["content-type", "text/event-stream"]],
      body: (async function* () {
        yield bytes.slice(0, cut);
        yield bytes.slice(cut);
      })(),
      cancel: () => undefined,
    };
    const { result } = await send({ call: () => split });
    expect(success(result)).toEqual({ content: [{ type: "text", text: "café" }] });
  });

  it("refuses an event stream that ends with no response", async () => {
    const { result } = await send({
      call: () => eventStream([{ jsonrpc: "2.0", method: "notifications/message" }, { jsonrpc: "2.0", id: 9, result: OK_RESULT }]),
    });
    expect(failure(result, "Invalid response")).toEqual({
      title: "Invalid response",
      detail: "The MCP server's event stream ended with no response to tools/call.",
      status: 200,
    });
    expect(result.exchanges).toEqual([]);
  });

  it("refuses an empty body, JSON that does not parse, and a body with no response", async () => {
    const empty = await send({ call: () => reply(200) });
    expect(failure(empty.result, "Invalid response").detail).toBe("The MCP server answered tools/call with no body.");
    const bad = await send({ call: () => reply(200, "{", [["content-type", "application/json"]]) });
    expect(failure(bad.result, "Invalid response").detail).toContain("answered tools/call with JSON that does not parse");
    const other = await send({ call: () => rpcReply(7, OK_RESULT) });
    expect(failure(other.result, "Invalid response").detail).toBe("The MCP server's answer holds no response to tools/call.");
    const init = await send({ initialize: () => rpcReply(1, "ready", [["Mcp-Session-Id", SESSION_ID]]) });
    expect(failure(init.result, "Invalid response").detail).toBe("The MCP server's initialize result is not an object.");
    expect(methods(init.requests)).toEqual(["initialize", "DELETE"]);
  });

  it("names a JSON-RPC error with its code, and records no exchange", async () => {
    const { result, requests } = await send({ call: () => rpcFailure(2, { code: -32602, message: "Unknown tool: read_file" }) });
    expect(failure(result, "MCP error")).toEqual({ title: "MCP error", detail: "Unknown tool: read_file (code -32602)", status: undefined });
    expect(result.exchanges).toEqual([]);
    expect(result.attempts).toBe(1);
    expect(methods(requests)).toContain("DELETE");

    const init = await send({ initialize: () => rpcFailure(1, "no") });
    expect(failure(init.result, "MCP error").detail).toBe('"no"');
    expect(init.result.attempts).toBe(1);
  });
});

describe("the result", () => {
  it("keeps content, structuredContent, and isError, and drops _meta", async () => {
    const content = [{ type: "text", text: "3 lines", annotations: { audience: ["user"] } }];
    const { result } = await send({
      call: () => rpcReply(2, { content, structuredContent: { lines: 3 }, isError: true, _meta: { trace: "t1" } }),
    });
    const expected: CallToolResult = { content, structuredContent: { lines: 3 }, isError: true };
    expect(success(result)).toEqual(expected);
    const exchanges = result.exchanges ?? [];
    expect(exchanges).toEqual([{ request: { name: "read_file", arguments: ARGS }, response: expected }]);
    expect(() => recordedExchangeSchema.parse(exchanges[0])).not.toThrow();
  });

  it("treats a null structuredContent or isError as absent", async () => {
    const { result } = await send({ call: () => rpcReply(2, { ...OK_RESULT, structuredContent: null, isError: null }) });
    expect(success(result)).toEqual(OK_RESULT);
  });

  it.each([
    ["no object", null, "The tools/call result is not an object."],
    ["no content list", { content: "ok" }, "The tools/call result has no content list."],
    ["an item with no type", { content: [{ text: "ok" }] }, "Content item 0 is not an object with a string type."],
    ["a list for structuredContent", { ...OK_RESULT, structuredContent: [1] }, "The tools/call result's structuredContent is not an object."],
    ["a string for isError", { ...OK_RESULT, isError: "yes" }, "The tools/call result's isError is not a boolean."],
  ])("refuses a result with %s", async (_case, value, detail) => {
    const { result } = await send({ call: () => rpcReply(2, value) });
    expect(failure(result, "Invalid response")).toEqual({ title: "Invalid response", detail, status: 200 });
    expect(result.exchanges).toEqual([]);
  });
});

describe("retries", () => {
  it("retries a busy initialize after Retry-After", async () => {
    const { result, requests } = await send({ initialize: onceThen(() => busy(503, [["Retry-After", "0"]]), () => initialized()) });
    success(result);
    expect(result.attempts).toBe(2);
    expect(methods(requests)).toEqual(["initialize", "initialize", "notifications/initialized", "tools/call", "DELETE"]);
  });

  it("retries a busy notifications/initialized, and ends the first session", async () => {
    const { result, requests } = await send({ initialized: onceThen(() => busy(429), () => reply(202)) });
    success(result);
    expect(methods(requests)).toEqual([
      "initialize",
      "notifications/initialized",
      "DELETE",
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
  });

  it("gives up when the Retry-After runs past the deadline", async () => {
    const { result, requests } = await send(
      { initialize: () => busy(503, [["Retry-After", "60"]]) },
      { shaping: { deadline_ms: 1_000 } },
    );
    expect(failure(result, "Busy").status).toBe(503);
    expect(requests).toHaveLength(1);
  });

  it("never retries another status before tools/call", async () => {
    const init = await send({ initialize: () => reply(401, { title: "Unauthorized", detail: "Bad token." }) });
    expect(failure(init.result, "Unauthorized")).toEqual({ title: "Unauthorized", detail: "Bad token.", status: 401 });
    expect(methods(init.requests)).toEqual(["initialize"]);
    const notify = await send({ initialized: () => reply(400) });
    expect(failure(notify.result, "Upstream error").detail).toBe("The upstream answered 400.");
    expect(methods(notify.requests)).toEqual(["initialize", "notifications/initialized", "DELETE"]);
  });

  it("never retries a busy tools/call, and records its response", async () => {
    const { result, requests } = await send({ call: () => busy(503, [["Retry-After", "0"], ["Set-Cookie", "s=1"]]) });
    expect(failure(result, "Busy").status).toBe(503);
    expect(result.attempts).toBe(1);
    expect(methods(requests)).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    const exchanges = result.exchanges ?? [];
    expect(exchanges).toEqual([
      {
        request: { name: "read_file", arguments: ARGS },
        response: { status: 503, headers: { "content-type": "application/json", "Retry-After": "0" }, body: { title: "Busy" } },
      },
    ]);
    expect(() => recordedExchangeSchema.parse(exchanges[0])).not.toThrow();
  });

  it("retries a tools/call the Transport says never left", async () => {
    const { result, requests } = await send({
      call: onceThen(
        () => {
          throw new TransportError("not_sent", "The connection was refused.", false);
        },
        () => rpcReply(2, OK_RESULT),
      ),
    });
    expect(success(result)).toEqual(OK_RESULT);
    expect(result.attempts).toBe(2);
    expect(methods(requests)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
      "initialize",
      "notifications/initialized",
      "tools/call",
      "DELETE",
    ]);
  });

  it("retries a lost connection before initialize was sent", async () => {
    const { result } = await send({
      initialize: onceThen(
        () => {
          throw new TransportError("disconnected", "The relay is not connected.", false);
        },
        () => initialized(),
      ),
    });
    success(result);
    expect(result.attempts).toBe(2);
  });

  it.each([
    ["a send that may have arrived", new TransportError("timeout", "No answer in time.", true), "Deadline exceeded"],
    ["a refused address", new TransportError("refused_address", "10.0.0.1 is a private address.", false), "Address refused"],
    ["a refused host", new TransportError("refused_host", "The host is not allowed.", false), "Host refused"],
    ["an unsupported route", new TransportError("unsupported", "No MCP over this relay.", false), "Unsupported transport"],
    ["an error that is not a TransportError", new Error("socket hang up"), "Transport error"],
  ])("never retries %s", async (_case, error, title) => {
    const { result, requests } = await send({ call: () => Promise.reject(error) });
    failure(result, title);
    expect(result.attempts).toBe(1);
    expect(methods(requests).filter((m) => m === "tools/call")).toHaveLength(1);
  });
});

describe("refusals before anything is sent", () => {
  it.each([
    ["a remote source on HTTP+SSE", mcpManifestServer({ type: "remote", url: "https://mcp.example.com/sse", transport: "sse" }, { type: "remote" })],
    [
      "a registry lock on HTTP+SSE",
      mcpManifestServer({ type: "registry", name: "files" }, { type: "registry", url: "https://mcp.example.com/sse", transport: "sse" }),
    ],
  ])("refuses %s", async (_case, server: ManifestServer) => {
    const { result, requests } = await send({}, { server });
    expect(failure(result, "Unsupported transport").detail).toBe(
      "files uses the HTTP+SSE transport. The gateway calls MCP servers over streamable HTTP only.",
    );
    expect(result.attempts).toBe(0);
    expect(requests).toEqual([]);
  });

  it("sends a server on the local network to the local route", async () => {
    const { result, requests } = await send({}, { network: "local" });
    expect(failure(result, "Unsupported transport").detail).toContain("go through the local route");
    expect(requests).toEqual([]);
  });

  it("refuses an environment with no url", async () => {
    const { result, requests } = await send({}, { url: undefined });
    failure(result, "Invalid environment");
    expect(requests).toEqual([]);
  });
});

describe("the credential", () => {
  it("puts a header credential on every request, the DELETE too, and in no record", async () => {
    const { result, requests } = await send({}, { credential: { type: "bearer", token: "tok_secret" } });
    success(result);
    expect(requests).toHaveLength(4);
    expect(requests.map((r) => header(r, "authorization"))).toEqual(Array(4).fill("Bearer tok_secret"));
    expect(JSON.stringify(result.exchanges)).not.toContain("tok_secret");
  });

  it("puts a query credential after the endpoint's own query", async () => {
    const auth: ManifestAuth = { mode: "service", scheme: "key", apply: { type: "api_key", in: "query", name: "key" } };
    const { result, requests } = await send(
      {},
      { url: "https://mcp.example.com/mcp?v=1", auth, credential: { type: "api_key", value: "k 1" } },
    );
    success(result);
    expect(requests.map((r) => r.target.path)).toEqual(Array(4).fill("/mcp?v=1&key=k%201"));
    expect(JSON.stringify(result.exchanges)).not.toContain("k 1");
  });

  it("passes a relay credential beside each request", async () => {
    const relay = { name: "files-token", scheme: "bearer" as const };
    const { requests } = await send({}, { network: "relay:a-intel-east", credential: { type: "relay", credential: relay } });
    expect(requests.map((r) => r.relay_credential)).toEqual(Array(4).fill(relay));
    expect(requests.map((r) => r.network)).toEqual(Array(4).fill("relay:a-intel-east"));
  });
});

describe("the deadline and cancel", () => {
  it("ends a session that outlives the deadline", async () => {
    const { result, requests } = await send({ initialize: never }, { shaping: { deadline_ms: 20 } });
    expect(failure(result, "Deadline exceeded").detail).toContain("20 ms");
    expect(methods(requests)).toEqual(["initialize"]);
  });

  it("ends the session when tools/call outlives the deadline, and releases a late response", async () => {
    const late = rpcReply(2, OK_RESULT);
    const { result, requests } = await send(
      { call: () => new Promise<HttpTransportResponse>((resolve) => setTimeout(() => resolve(late), 40)) },
      { shaping: { deadline_ms: 20 } },
    );
    failure(result, "Deadline exceeded");
    expect(methods(requests)).toEqual(["initialize", "notifications/initialized", "tools/call", "DELETE"]);
    await tick(60);
    expect(late.cancel).toHaveBeenCalled();
  });

  it("ends the session when a body outlives the deadline", async () => {
    const init = hanging(200, [], [["Mcp-Session-Id", SESSION_ID]]);
    const slowInit = await send({ initialize: () => init }, { shaping: { deadline_ms: 20 } });
    failure(slowInit.result, "Deadline exceeded");
    expect(init.cancel).toHaveBeenCalled();
    expect(methods(slowInit.requests)).toEqual(["initialize", "DELETE"]);

    const slowNotify = await send({ initialized: () => hanging(202) }, { shaping: { deadline_ms: 20 } });
    failure(slowNotify.result, "Deadline exceeded");

    const stream = hanging(200, ['data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'], [["content-type", "text/event-stream"]]);
    const slowStream = await send({ call: () => stream }, { shaping: { deadline_ms: 20 } });
    failure(slowStream.result, "Deadline exceeded");
    expect(stream.cancel).toHaveBeenCalled();
  });

  it("names the status when a failed response's body outlives the deadline", async () => {
    const { result } = await send({ call: () => hanging(500) }, { shaping: { deadline_ms: 20 } });
    expect(failure(result, "Upstream error")).toMatchObject({ detail: "The upstream answered 500.", status: 500 });
    expect(result.exchanges).toEqual([{ request: { name: "read_file", arguments: ARGS }, response: { status: 500 } }]);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const pending = send({ initialize: never }, { signal: controller.signal });
    controller.abort();
    failure((await pending).result, "Cancelled");
  });
});

describe("the local route", () => {
  const TOOL = {
    name: "read_file",
    version: 3,
    definition_hash: `sha256:${"a".repeat(64)}`,
    definition: { name: "files__read_file" },
    request: READ_FILE,
  } as unknown as ManifestTool;
  const LOCAL = mcpManifestServer({ type: "local" }, { type: "local", package: { digest: `sha256:${"b".repeat(64)}` } });

  async function local(
    answer: (call: LocalCall, number: number) => Promise<CallToolResult>,
    options: Omit<ContextOptions, "transport"> = {},
    tool: ManifestTool = TOOL,
  ): Promise<{ result: SendResult; locals: LocalCall[]; requests: HttpTransportRequest[] }> {
    const fake = fakeHttp(() => reply(500), answer);
    const result = await sendLocal(
      tool,
      ARGS,
      sendContext({ transport: fake.transport, url: undefined, network: "local", server: LOCAL, ...options }),
      { backoff_ms: () => 1 },
    );
    return { result, locals: fake.locals, requests: fake.requests };
  }

  it("sends the call to the local gateway with the package digest, and records it", async () => {
    const { result, locals, requests } = await local(() => Promise.resolve({ ...OK_RESULT, _meta: { x: 1 } } as CallToolResult));
    expect(success(result)).toEqual(OK_RESULT);
    expect(requests).toEqual([]);
    expect(locals).toHaveLength(1);
    const [call] = locals;
    expect(call).toMatchObject({
      tool: "files__read_file",
      upstream: "read_file",
      version: 3,
      definition_hash: `sha256:${"a".repeat(64)}`,
      package_digest: `sha256:${"b".repeat(64)}`,
      arguments: ARGS,
    });
    expect(call?.deadline_ms).toBeGreaterThan(0);
    expect(call?.deadline_ms).toBeLessThanOrEqual(30_000);
    expect(call?.signal.aborted).toBe(false);
    expect(result.exchanges).toEqual([{ request: { name: "read_file", arguments: ARGS }, response: OK_RESULT }]);
  });

  it("takes the digest from a registry package", async () => {
    const server = mcpManifestServer({ type: "registry" }, { type: "registry", package: { digest: `sha256:${"c".repeat(64)}` } });
    const { locals } = await local(() => Promise.resolve(OK_RESULT), { server });
    expect(locals[0]?.package_digest).toBe(`sha256:${"c".repeat(64)}`);
  });

  it.each([
    ["a registry endpoint", mcpManifestServer({ type: "registry" }, { type: "registry", url: "https://mcp.example.com/mcp", transport: "http" })],
    ["a remote lock", REMOTE_MCP],
  ])("refuses a server with no package: %s", async (_case, server: ManifestServer) => {
    const { result, locals } = await local(() => Promise.resolve(OK_RESULT), { server });
    expect(failure(result, "Invalid environment").detail).toContain("pins no package");
    expect(locals).toEqual([]);
  });

  it("refuses another network and another kind of tool", async () => {
    const cloud = await local(() => Promise.resolve(OK_RESULT), { network: "cloud" });
    expect(failure(cloud.result, "Invalid environment").detail).toContain("network is cloud");
    const http = { ...TOOL, name: "list_charges", request: { kind: "http", operation: "op", method: "GET", path: "/", parameters: [] } } as unknown as ManifestTool;
    const wrong = await local(() => Promise.resolve(OK_RESULT), {}, http);
    expect(failure(wrong.result, "Invalid request").detail).toBe("list_charges is a http tool, and only an MCP tool runs locally.");
    expect([...cloud.locals, ...wrong.locals]).toEqual([]);
  });

  it("retries only a call that never left", async () => {
    const retried = await local((_call, n) =>
      n === 1 ? Promise.reject(new TransportError("not_sent", "The gateway is starting.", false)) : Promise.resolve(OK_RESULT),
    );
    expect(success(retried.result)).toEqual(OK_RESULT);
    expect(retried.result.attempts).toBe(2);
    const sent = await local(() => Promise.reject(new TransportError("disconnected", "The machine went away.", true)));
    failure(sent.result, "Not connected");
    expect(sent.locals).toHaveLength(1);
    const thrown = await local(() => {
      throw new Error("boom");
    });
    expect(failure(thrown.result, "Transport error").detail).toBe("boom");
  });

  it("refuses a result that is not a tools/call result", async () => {
    const { result } = await local(() => Promise.resolve({ content: "ok" } as unknown as CallToolResult));
    expect(failure(result, "Invalid response")).toEqual({
      title: "Invalid response",
      detail: "The tools/call result has no content list.",
      status: undefined,
    });
  });

  it("ends a call that outlives the deadline", async () => {
    const { result } = await local(() => new Promise(() => undefined), { shaping: { deadline_ms: 20 } });
    expect(failure(result, "Deadline exceeded").detail).toContain("20 ms");
  });
});
