// transport.ts: the recorded responses come back in order, as bytes the
// executor reads the way it reads the network's.
import { describe, expect, it } from "vitest";
import type { RecordedExchange } from "../contract/tests-files";
import { decodeText, encodeText } from "../execute/body";
import { MCP_PROTOCOL_VERSION } from "../execute/mcp";
import {
  TransportError,
  type GrpcTransportRequest,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type LocalCall,
} from "../execute/transport";
import { replayTransport, servedHttp } from "./transport";

type Response = RecordedExchange["response"];

function exchange(response: Response): RecordedExchange {
  return { request: { method: "GET", path: "/charges" }, response };
}

function request(method: string, body: unknown = undefined): HttpTransportRequest {
  const bytes = body === undefined ? new Uint8Array(0) : encodeText(typeof body === "string" ? body : JSON.stringify(body));
  return { target: { method }, headers: [], body: bytes } as unknown as HttpTransportRequest;
}

function rpc(method: string, id?: number): HttpTransportRequest {
  return request("POST", { jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method });
}

async function bodyText(response: HttpTransportResponse): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return decodeText(Buffer.concat(chunks));
}

async function refusal(pending: Promise<unknown>): Promise<TransportError> {
  const error = await pending.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(TransportError);
  return error as TransportError;
}

const LOCAL_CALL = {} as LocalCall;

describe("servedHttp", () => {
  it("writes a JSON body as JSON, and names the type when the recording has none", async () => {
    const served = servedHttp({ status: 200, body: { id: "ch_1" } });
    expect(served.status).toBe(200);
    expect(served.headers).toEqual([["content-type", "application/json"]]);
    expect(await bodyText(served)).toBe('{"id":"ch_1"}');
    served.cancel();
  });

  it("writes a text body as it was", async () => {
    const served = servedHttp({ status: 200, headers: { "Content-Type": "text/plain" }, body: "plain words" });
    expect(served.headers).toEqual([["Content-Type", "text/plain"]]);
    expect(await bodyText(served)).toBe("plain words");
  });

  it("writes a JSON string as JSON when the type is JSON", async () => {
    const served = servedHttp({ status: 200, headers: { "content-type": "application/json" }, body: "quoted" });
    expect(await bodyText(served)).toBe('"quoted"');
  });

  it("leaves out Retry-After and Content-Length, and sends no bytes for no body", async () => {
    const served = servedHttp({ status: 204, headers: { "Retry-After": "120", "Content-Length": "0", etag: "v1" } });
    expect(served.headers).toEqual([["etag", "v1"]]);
    expect(await bodyText(served)).toBe("");
  });
});

describe("replayTransport on HTTP", () => {
  it("serves each response once, in order", async () => {
    const replay = replayTransport([exchange({ status: 200, body: 1 }), exchange({ status: 201, body: 2 })], "http");
    expect((await replay.transport.http(request("GET"))).status).toBe(200);
    expect((await replay.transport.http(request("GET"))).status).toBe(201);
    expect(replay.used()).toBe(2);
    expect(replay.problem()).toBeUndefined();
  });

  it("serves a retryable status again for the retry, and counts it once", async () => {
    const replay = replayTransport([exchange({ status: 503 })], "http");
    expect((await replay.transport.http(request("GET"))).status).toBe(503);
    expect((await replay.transport.http(request("GET"))).status).toBe(503);
    expect(replay.used()).toBe(1);
  });

  it("refuses a request past the end, and keeps the first problem", async () => {
    const replay = replayTransport([exchange({ status: 200 })], "http");
    await replay.transport.http(request("GET"));
    const error = await refusal(replay.transport.http(request("GET")));
    expect(error.code).toBe("unsupported");
    expect(error.sent).toBe(false);
    await refusal(replay.transport.http(request("GET")));
    expect(replay.problem()).toEqual({
      part: "exchanges",
      exchange: 2,
      expected: 1,
      actual: 2,
      message: "The executor sent request 2, but the recording holds 1.",
    });
  });

  it("refuses a gRPC response for an HTTP request", async () => {
    const replay = replayTransport([exchange({ code: "OK", messages: [] })], "http");
    await refusal(replay.transport.http(request("GET")));
    expect(replay.problem()?.message).toBe("Exchange 1 records a gRPC response, but the tool sends HTTP requests.");
  });

  it("refuses a gRPC call", async () => {
    const replay = replayTransport([exchange({ code: "OK" })], "http");
    await refusal(replay.transport.grpc({} as GrpcTransportRequest));
    expect(replay.problem()).toMatchObject({ part: "response", exchange: 1, message: "Replay does not run gRPC calls." });
  });
});

describe("replayTransport on a remote MCP server", () => {
  const RESULT = { content: [{ type: "text", text: "done" }] };

  it("answers the session itself and takes a recorded response only for tools/call", async () => {
    const replay = replayTransport([exchange(RESULT)], "mcp");
    const initialize = await replay.transport.http(rpc("initialize", 1));
    expect(JSON.parse(await bodyText(initialize))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "oxagen-replay", version: "1" },
      },
    });
    expect((await replay.transport.http(rpc("notifications/initialized"))).status).toBe(202);
    const call = await replay.transport.http(request("POST", [{ jsonrpc: "2.0", id: 2, method: "tools/call" }]));
    expect(JSON.parse(await bodyText(call))).toEqual({ jsonrpc: "2.0", id: 2, result: RESULT });
    expect((await replay.transport.http(request("DELETE"))).status).toBe(204);
    expect(replay.used()).toBe(1);
  });

  it("serves a recorded HTTP failure for tools/call", async () => {
    const replay = replayTransport([exchange({ status: 500, body: "down" })], "mcp");
    expect((await replay.transport.http(rpc("tools/call", 2))).status).toBe(500);
  });

  it("refuses a gRPC response for tools/call", async () => {
    const replay = replayTransport([exchange({ code: "OK" })], "mcp");
    await refusal(replay.transport.http(rpc("tools/call", 2)));
    expect(replay.problem()?.message).toBe("Exchange 1 records a gRPC response, but the tool is on an MCP server.");
  });

  it("refuses a method the replay cannot answer", async () => {
    const replay = replayTransport([exchange(RESULT)], "mcp");
    await refusal(replay.transport.http(rpc("tools/list", 3)));
    expect(replay.problem()).toEqual({
      part: "response",
      exchange: 1,
      expected: "tools/call",
      actual: "tools/list",
      message: 'The replay has no answer for the MCP request "tools/list".',
    });
  });

  it("refuses a body that is not JSON-RPC", async () => {
    const replay = replayTransport([exchange(RESULT)], "mcp");
    await refusal(replay.transport.http(request("POST", "not json")));
    expect(replay.problem()?.message).toBe("The replay has no answer for the MCP request null.");
  });

  it("refuses a batch whose first message is not an object", async () => {
    const replay = replayTransport([exchange(RESULT)], "mcp");
    await refusal(replay.transport.http(request("POST", ["tools/call"])));
    expect(replay.problem()?.actual).toBeUndefined();
  });
});

describe("replayTransport on the local gateway", () => {
  it("returns the recorded tools/call result", async () => {
    const replay = replayTransport([exchange({ content: [{ type: "text", text: "hello" }], isError: false })], "local");
    expect(await replay.transport.local(LOCAL_CALL)).toEqual({ content: [{ type: "text", text: "hello" }], isError: false });
  });

  it("refuses an HTTP response", async () => {
    const replay = replayTransport([exchange({ status: 200 })], "local");
    await refusal(replay.transport.local(LOCAL_CALL));
    expect(replay.problem()?.message).toBe("Exchange 1 records an HTTP response, but the tool runs on the local gateway.");
  });

  it("refuses a result the executor cannot read", async () => {
    const replay = replayTransport([exchange({ content: [{ text: "no type" }] })], "local");
    await refusal(replay.transport.local(LOCAL_CALL));
    expect(replay.problem()).toMatchObject({
      part: "response",
      exchange: 1,
      message: "Exchange 1 records a tools/call result the executor cannot read. Content item 0 is not an object with a string type.",
    });
  });
});
