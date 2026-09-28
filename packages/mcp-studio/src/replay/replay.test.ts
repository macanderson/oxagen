// replay.ts: a recorded call runs through the executor against its own
// recording. The fixture recordings must match, and each kind of drift must
// be reported at the first place it shows.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ManifestServer, ManifestShaping, ManifestTool } from "../contract/manifest";
import { parseRecordedCalls, parseToolManifest } from "../contract/parse";
import type { RecordedCall, RecordedExchange } from "../contract/tests-files";
import { listRequest, manifestServer, manifestTool, type ServerOptions } from "../execute/__tests__/manifest";
import type { Paging } from "../model/upstream-tool";
import { recordedResult, replayCall, type ReplayResult } from "./replay";

const FIXTURES = fileURLToPath(new URL("../../fixtures/", import.meta.url));

function text(path: string): string {
  return readFileSync(join(FIXTURES, path), "utf8");
}

function fixtureServer(name: string): ManifestServer {
  const manifest = parseToolManifest(text("expected/tool-manifest.json"));
  if (!manifest.ok) throw new Error("expected/tool-manifest.json does not parse.");
  const server = manifest.value.servers.find((entry) => entry.name === name);
  if (server === undefined) throw new Error(`The fixture manifest has no server named ${name}.`);
  return server;
}

function fixtureCalls(name: string): RecordedCall[] {
  const calls = parseRecordedCalls(text(`servers/${name}/tests/calls.jsonl`));
  if (!calls.ok) throw new Error(`servers/${name}/tests/calls.jsonl does not parse.`);
  return calls.value;
}

function fixtureCall(name: string, tool: string): RecordedCall {
  const call = fixtureCalls(name).find((entry) => entry.tool === tool);
  if (call === undefined) throw new Error(`servers/${name}/tests/calls.jsonl has no ${tool} call.`);
  return call;
}

const JSON_TYPE = { "content-type": "application/json" };

function server(tools: Record<string, ManifestTool>, options: ServerOptions = {}): ManifestServer {
  return { ...manifestServer(options), tools };
}

function ok(body: unknown): RecordedExchange["response"] {
  return { status: 200, headers: JSON_TYPE, body };
}

function listTool(shaping: Partial<ManifestShaping> = {}): ManifestTool {
  return manifestTool({
    request: listRequest(["customer", "limit"]),
    properties: { customer: { type: "string" }, limit: { type: "integer" } },
    shaping,
  });
}

const CHARGES = { data: [{ id: "ch_1", amount: 4000 }] };

/** A GET of one customer's charges, answered with CHARGES. */
function listCall(overrides: Partial<RecordedCall> = {}): RecordedCall {
  return {
    tool: "list_charges",
    arguments: { customer: "cus_81" },
    exchanges: [{ request: { method: "GET", path: "/charges", query: { customer: "cus_81" } }, response: ok(CHARGES) }],
    result: CHARGES,
    ...overrides,
  };
}

const CURSOR: Paging = { style: "cursor", input: "cursor", next: "next_cursor", items: "data" };

const PAGED = manifestTool({
  request: listRequest(["cursor"]),
  properties: { cursor: { type: "string" } },
  shaping: { paginate: "cursor" },
  paging: CURSOR,
});

/** Two pages by cursor: ch_1 with cursor cur_1, then ch_2 with no cursor. */
function pagedCall(secondCursor = "cur_1"): RecordedCall {
  return {
    tool: "list_charges",
    arguments: {},
    exchanges: [
      { request: { method: "GET", path: "/charges" }, response: ok({ data: [{ id: "ch_1" }], next_cursor: "cur_1" }) },
      { request: { method: "GET", path: "/charges", query: { cursor: secondCursor } }, response: ok({ data: [{ id: "ch_2" }] }) },
    ],
    result: { data: [{ id: "ch_1" }, { id: "ch_2" }] },
  };
}

function difference(result: ReplayResult) {
  if (result.status !== "differs") throw new Error(`The replay did not differ: ${JSON.stringify(result)}`);
  return result.difference;
}

describe("the fixture recordings", () => {
  const cases = ["billing", "stripe"].flatMap((name) =>
    fixtureCalls(name).map((call): [string, string, RecordedCall] => [name, call.tool, call]),
  );

  it.each(cases)("%s replays its %s recording", async (name, _tool, call) => {
    expect(await replayCall(fixtureServer(name), call)).toEqual({ status: "match", exchanges: call.exchanges.length });
  });
});

describe("replayCall", () => {
  it("matches a call whose request and result are unchanged", async () => {
    expect(await replayCall(server({ list_charges: listTool() }), listCall())).toEqual({ status: "match", exchanges: 1 });
  });

  it("serves a paged call's pages in order", async () => {
    expect(await replayCall(server({ list_charges: PAGED }), pagedCall())).toEqual({ status: "match", exchanges: 2 });
  });

  it("reports a changed request on the second page", async () => {
    expect(difference(await replayCall(server({ list_charges: PAGED }), pagedCall("cur_0")))).toEqual({
      part: "request",
      exchange: 2,
      path: "query.cursor",
      expected: "cur_0",
      actual: "cur_1",
      message: 'Exchange 2\'s request differs at query.cursor: the recording has "cur_0", and the build has "cur_1".',
    });
  });

  it("reports a request body that changed since the recording", async () => {
    const call = fixtureCall("billing", "create_refund");
    const [first] = call.exchanges;
    if (first === undefined) throw new Error("The create_refund recording has no exchange.");
    const request = { ...first.request, body: { charge_id: "ch_3P9", amount: 5000, reason: "duplicate" } };
    const changed = { ...call, exchanges: [{ ...first, request }] };
    expect(difference(await replayCall(fixtureServer("billing"), changed))).toMatchObject({
      part: "request",
      exchange: 1,
      path: "body.amount",
      expected: 5000,
      actual: 4000,
    });
  });

  it("reports a parameter tools.toml now fixes", async () => {
    const tool = listTool({ fixed: { limit: 10 } });
    expect(difference(await replayCall(server({ list_charges: tool }), listCall()))).toEqual({
      part: "request",
      exchange: 1,
      path: "query.limit",
      expected: undefined,
      actual: "10",
      message: 'Exchange 1\'s request differs at query.limit: the recording has nothing, and the build has "10".',
    });
  });

  it("reports a result whose shape changed", async () => {
    const tool = listTool({ select: ["data[].id"] });
    expect(difference(await replayCall(server({ list_charges: tool }), listCall()))).toEqual({
      part: "result",
      path: "data[0].amount",
      expected: 4000,
      actual: undefined,
      message: "The result differs at data[0].amount: the recording has 4000, and the replay has nothing.",
    });
  });

  it("reports a request past the end of the recording", async () => {
    const [first] = pagedCall().exchanges;
    if (first === undefined) throw new Error("The paged recording has no exchange.");
    const call = { ...pagedCall(), exchanges: [first], result: { data: [{ id: "ch_1" }] } };
    expect(difference(await replayCall(server({ list_charges: PAGED }), call))).toEqual({
      part: "exchanges",
      exchange: 2,
      path: "",
      expected: 1,
      actual: 2,
      message: "The executor sent request 2, but the recording holds 1.",
    });
  });

  it("reports recorded exchanges the replay never used", async () => {
    const [, second] = pagedCall().exchanges;
    if (second === undefined) throw new Error("The paged recording has no second exchange.");
    const call = listCall();
    const extra = { ...call, exchanges: [...call.exchanges, second] };
    expect(difference(await replayCall(server({ list_charges: listTool() }), extra))).toEqual({
      part: "exchanges",
      path: "",
      expected: 2,
      actual: 1,
      message: "The replay used 1 of the 2 recorded exchanges.",
    });
  });

  it("names the error when a call ends before it sends", async () => {
    const tool = manifestTool({
      request: listRequest(["customer"]),
      properties: { customer: { type: "string" } },
      required: ["customer"],
    });
    const found = difference(await replayCall(server({ list_charges: tool }), listCall({ arguments: {} })));
    expect(found).toMatchObject({ part: "exchanges", expected: 1, actual: 0 });
    expect(found.message).toMatch(
      /^The replay used 0 of the 1 recorded exchanges\. The call ended with an error: The arguments do not match/,
    );
  });

  it("reports a recorded response of the wrong kind", async () => {
    const call = listCall({
      exchanges: [{ request: { name: "list_charges", arguments: {} }, response: { content: [{ type: "text", text: "{}" }] } }],
    });
    expect(difference(await replayCall(server({ list_charges: listTool() }), call))).toEqual({
      part: "response",
      exchange: 1,
      path: "",
      expected: "an MCP tools/call result",
      actual: "an HTTP response",
      message: "Exchange 1 records an MCP tools/call result, but the tool sends HTTP requests.",
    });
  });

  it("serves a retried response again, because the recording keeps only the final attempt", async () => {
    const unavailable = listCall({
      exchanges: [
        {
          request: { method: "GET", path: "/charges", query: { customer: "cus_81" } },
          response: { status: 503, headers: { "retry-after": "120" }, body: "" },
        },
      ],
      result: "",
    });
    const srv = server({ list_charges: listTool() });
    const found = difference(await replayCall(srv, unavailable));
    expect(found.part).toBe("result");
    expect(String(found.actual)).toContain("503");
    expect(found.message).toContain("The call ended with an error:");
    expect(await replayCall(srv, { ...unavailable, result: found.actual as string })).toEqual({
      status: "match",
      exchanges: 1,
    });
  });

  it("replays a call on the local gateway", async () => {
    const local = server(
      { read_file: manifestTool({ name: "read_file", request: { kind: "mcp", tool: "read_file" } }) },
      {
        environments: { default: { sandbox: true, network: "local" } },
        pinned: { type: "local", package: { digest: `sha256:${"c".repeat(64)}` } },
      },
    );
    const call: RecordedCall = {
      tool: "read_file",
      arguments: {},
      exchanges: [{ request: { name: "read_file", arguments: {} }, response: { content: [{ type: "text", text: "hello" }] } }],
      result: "hello",
    };
    expect(await replayCall(local, call)).toEqual({ status: "match", exchanges: 1 });
  });

  it("runs in the first environment when none is the sandbox", async () => {
    const environments = { live: { sandbox: false, url: "https://api.example.com/v2", network: "cloud" } };
    expect(await replayCall(server({ list_charges: listTool() }, { environments }), listCall())).toEqual({
      status: "match",
      exchanges: 1,
    });
  });

  it("skips a tool that is no longer in tools.toml", async () => {
    expect(await replayCall(server({}), listCall())).toEqual({
      status: "skipped",
      reason: "list_charges is not in tools.toml, so replay skips its recorded calls.",
    });
  });

  it("skips a gRPC tool", async () => {
    const tool = manifestTool({
      request: {
        kind: "grpc",
        method: "/billing.v1.Charges/ListCharges",
        streaming: "unary",
        idempotency_level: "NO_SIDE_EFFECTS",
        request_type: "billing.v1.ListChargesRequest",
        response_type: "billing.v1.ListChargesResponse",
      },
    });
    expect(await replayCall(server({ list_charges: tool }), listCall())).toEqual({
      status: "skipped",
      reason: "Replay does not run gRPC tools.",
    });
  });

  it("skips a server with no environment", async () => {
    expect(await replayCall(server({ list_charges: listTool() }, { environments: {} }), listCall())).toEqual({
      status: "skipped",
      reason: "The server billing has no environment to replay in.",
    });
  });
});

describe("recordedResult", () => {
  it("takes structuredContent when the result has it", () => {
    expect(recordedResult({ content: [{ type: "text", text: "{}" }], structuredContent: { id: "re_1" } })).toEqual({
      id: "re_1",
    });
  });

  it("joins the text items otherwise, and skips the rest", () => {
    const result = {
      content: [
        { type: "text", text: "first" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "second" },
      ],
    };
    expect(recordedResult(result)).toBe("first\nsecond");
  });
});
