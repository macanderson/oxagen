import { describe, expect, it, vi } from "vitest";
import {
  ceilingOf,
  createMcpGateway,
  type GatewayAttribution,
  type GatewayCallRecord,
  type GatewayFetch,
  type McpGatewayDeps,
  parseJsonRpc,
  readRpcBody,
  RPC_INVALID_REQUEST,
  RPC_REFUSED,
  toolCountOf,
  tooManyToolsMessage,
} from "./mcp-gateway";
import type { PolicyBundle } from "../wire";

const ENROLLMENT = "tch_abcdefghijklmnopqrstuv";

function attribution(
  overrides: Partial<GatewayAttribution> = {},
): GatewayAttribution {
  return {
    organizationId: "11111111-1111-4111-8111-111111111111",
    workspaceId: "22222222-2222-4222-8222-222222222222",
    orgSlug: "acme",
    workspaceSlug: "core",
    apiKey: "oxa_live_secretkey",
    hostEnrollmentId: ENROLLMENT,
    ...overrides,
  };
}

/** A control plane that answers with whatever the test hands it. */
function remote(
  result: unknown,
  status = 200,
): {
  fetch: GatewayFetch;
  calls: Array<{ url: string; init: Parameters<GatewayFetch>[1] }>;
} {
  const calls: Array<{ url: string; init: Parameters<GatewayFetch>[1] }> = [];
  const fetch: GatewayFetch = async (url, init) => {
    calls.push({ url, init });
    const body = JSON.parse(init.body) as { id?: unknown };
    return {
      ok: status < 400,
      status,
      text: async () =>
        JSON.stringify({ jsonrpc: "2.0", id: body.id ?? null, result }),
    };
  };
  return { fetch, calls };
}

function gateway(overrides: Partial<McpGatewayDeps> = {}) {
  const records: GatewayCallRecord[] = [];
  const logs: string[] = [];
  const deps: McpGatewayDeps = {
    attribution: () => attribution(),
    endpoint: "https://mcp.oxagen.sh/mcp",
    fetch: remote({}).fetch,
    record: (event) => records.push(event),
    log: (line) => logs.push(line),
    now: () => 1_000,
    ...overrides,
  };
  return { gw: createMcpGateway(deps), records, logs };
}

const CALL = {
  jsonrpc: "2.0" as const,
  id: 7,
  method: "tools/call",
  params: { name: "query_ontology", arguments: { q: "x" } },
};

const CTX = { sessionId: "sess-1" };

describe("attribution is required, never defaulted", () => {
  it("refuses a call when the machine is not enrolled", async () => {
    const { gw, records, logs } = gateway({ attribution: () => undefined });
    const response = await gw.handle(CALL, CTX);
    expect(response.status).toBe(403);
    const body = response.body as { error: { code: number; message: string } };
    expect(body.error.code).toBe(RPC_REFUSED);
    expect(body.error.message).toContain("not enrolled");
    // Nothing was forwarded and nothing was recorded under nobody's name.
    expect(records).toEqual([]);
    expect(logs.join(" ")).toContain("no enrollment");
  });

  it("never reaches the control plane without attribution", async () => {
    const upstream = vi.fn();
    const { gw } = gateway({
      attribution: () => undefined,
      fetch: upstream as unknown as GatewayFetch,
    });
    await gw.handle(CALL, CTX);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("re-reads attribution on every call, so a revoke takes effect at once", async () => {
    let live = true;
    const { fetch } = remote({ content: [] });
    const { gw } = gateway({
      fetch,
      attribution: () => (live ? attribution() : undefined),
    });
    expect((await gw.handle(CALL, CTX)).status).toBe(200);
    live = false;
    expect((await gw.handle(CALL, CTX)).status).toBe(403);
  });

  it("refuses an entry left behind by an earlier enrollment", async () => {
    const { gw } = gateway();
    const response = await gw.handle(CALL, {
      sessionId: "s",
      enrollmentId: "tch_zyxwvutsrqponmlkjihgfe",
    });
    expect(response.status).toBe(403);
    expect(
      (response.body as { error: { message: string } }).error.message,
    ).toContain("earlier enrollment");
  });

  it("accepts the scoped path when the enrollment matches", async () => {
    const { fetch } = remote({ content: [] });
    const { gw } = gateway({ fetch });
    const response = await gw.handle(CALL, {
      sessionId: "s",
      enrollmentId: ENROLLMENT,
    });
    expect(response.status).toBe(200);
  });
});

describe("the forward carries the host key, not the caller's", () => {
  it("presents the host API key and never the local bearer", async () => {
    const { fetch, calls } = remote({ content: [] });
    const { gw } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://mcp.oxagen.sh/mcp");
    expect(calls[0]?.init.headers["Authorization"]).toBe(
      "Bearer oxa_live_secretkey",
    );
    expect(calls[0]?.init.headers["X-Tacho-Host"]).toBe(ENROLLMENT);
  });

  it("forwards the JSON-RPC envelope unchanged", async () => {
    const { fetch, calls } = remote({ content: [] });
    const { gw } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual(CALL);
  });

  it("surfaces an unreachable control plane as a transport failure", async () => {
    const { gw, records } = gateway({
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const response = await gw.handle(CALL, CTX);
    expect(response.status).toBe(502);
    expect(
      (response.body as { error: { message: string } }).error.message,
    ).toContain("ECONNREFUSED");
    expect(records[0]?.status).toBe("error");
  });
});

describe("the tool ceiling", () => {
  const bundle = (maxTools: number): PolicyBundle =>
    ({
      tool_ceiling: {
        model_id: "openai/gpt-5",
        max_tools: maxTools,
        source: "OpenAI function-calling limit of 128 tools per request",
      },
    }) as unknown as PolicyBundle;

  const listOf = (n: number) => ({
    tools: Array.from({ length: n }, (_, i) => ({ name: `tool_${i}` })),
  });

  const LIST = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

  it("refuses a list that overflows, naming model, limit and count", async () => {
    const { fetch } = remote(listOf(130));
    const { gw, records } = gateway({ fetch, bundle: () => bundle(128) });
    const response = await gw.handle(LIST, CTX);
    const error = (
      response.body as {
        error: { code: number; message: string; data: unknown };
      }
    ).error;
    expect(error.code).toBe(RPC_REFUSED);
    expect(error.message).toContain("130 tools");
    expect(error.message).toContain("openai/gpt-5");
    expect(error.message).toContain("at most 128");
    expect(error.message).toContain(
      "OpenAI function-calling limit of 128 tools per request",
    );
    expect(error.data).toEqual({
      modelId: "openai/gpt-5",
      maxTools: 128,
      toolCount: 130,
    });
    // A refusal is a decision, so it is evidence.
    expect(records[0]?.status).toBe("rejected");
    expect(records[0]?.refusedReason).toBe("tool ceiling");
  });

  it("is not a gateway error: the client gets 200 and a JSON-RPC error", async () => {
    const { fetch } = remote(listOf(130));
    const { gw } = gateway({ fetch, bundle: () => bundle(128) });
    const response = await gw.handle(LIST, CTX);
    expect(response.status).toBe(200);
  });

  it("serves a list that fits", async () => {
    const { fetch } = remote(listOf(12));
    const { gw } = gateway({ fetch, bundle: () => bundle(128) });
    const response = await gw.handle(LIST, CTX);
    expect((response.body as { result: unknown }).result).toEqual(listOf(12));
  });

  it("serves a list at exactly the limit", async () => {
    const { fetch } = remote(listOf(128));
    const { gw } = gateway({ fetch, bundle: () => bundle(128) });
    expect((await gw.handle(LIST, CTX)).body).toHaveProperty("result");
  });

  it("serves any list when the mandate declares no ceiling", async () => {
    const { fetch } = remote(listOf(500));
    const { gw } = gateway({ fetch, bundle: () => undefined });
    expect((await gw.handle(LIST, CTX)).body).toHaveProperty("result");
  });

  it("does not apply the ceiling to a tools/call", async () => {
    const { fetch } = remote({ content: [] });
    const { gw } = gateway({ fetch, bundle: () => bundle(0) });
    expect((await gw.handle(CALL, CTX)).body).toHaveProperty("result");
  });

  it("reads a ceiling only when it is well formed", () => {
    expect(ceilingOf(undefined)).toBeUndefined();
    expect(ceilingOf({} as PolicyBundle)).toBeUndefined();
    expect(
      ceilingOf({ tool_ceiling: { model_id: "m" } } as unknown as PolicyBundle),
    ).toBeUndefined();
    expect(
      ceilingOf({
        tool_ceiling: { model_id: "m", max_tools: 3 },
      } as unknown as PolicyBundle),
    ).toEqual({ modelId: "m", maxTools: 3, source: "the workspace mandate" });
  });

  it("words the refusal the way the control plane words it", () => {
    const message = tooManyToolsMessage(
      { modelId: "openai/gpt-5", maxTools: 128, source: "the OpenAI limit" },
      200,
    );
    expect(message).toContain("200 tools");
    expect(message).toContain("at most 128");
    expect(message).toContain("the OpenAI limit");
  });
});

describe("evidence", () => {
  it("records a tool call with the connected app's name", async () => {
    const { fetch } = remote({ content: [] });
    const { gw, records } = gateway({ fetch });
    await gw.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "claude-desktop", version: "1.2.3" } },
      },
      CTX,
    );
    await gw.handle(CALL, CTX);
    expect(records).toEqual([
      {
        sessionId: "sess-1",
        client: "claude-desktop",
        toolName: "query_ontology",
        status: "ok",
        durationMs: 0,
      },
    ]);
  });

  it("does not file protocol traffic as a step somebody took", async () => {
    const { fetch } = remote({ tools: [] });
    const { gw, records } = gateway({ fetch });
    await gw.handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, CTX);
    await gw.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, CTX);
    await gw.handle({ jsonrpc: "2.0", id: 3, method: "ping" }, CTX);
    expect(records).toEqual([]);
  });

  it("records a refused call as rejected, with the reason", async () => {
    const fetch: GatewayFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          error: { code: -32002, message: "Tool blocked by workspace policy" },
        }),
    });
    const { gw, records } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(records[0]?.status).toBe("rejected");
    expect(records[0]?.refusedReason).toBe("Tool blocked by workspace policy");
  });

  it("falls back to unknown when the client never introduced itself", async () => {
    const { fetch } = remote({ content: [] });
    const { gw, records } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(records[0]?.client).toBe("unknown");
  });

  it("keeps one client name per session and forgets it on close", async () => {
    const { fetch } = remote({ content: [] });
    const { gw } = gateway({ fetch });
    await gw.handle(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "cursor" } },
      },
      { sessionId: "a" },
    );
    expect(gw.clientOf("a")).toBe("cursor");
    expect(gw.clientOf("b")).toBeUndefined();
    gw.forget("a");
    expect(gw.clientOf("a")).toBeUndefined();
  });

  it("times the call", async () => {
    let clock = 1_000;
    const { fetch } = remote({ content: [] });
    const { gw, records } = gateway({
      fetch,
      now: () => {
        const value = clock;
        clock += 42;
        return value;
      },
    });
    await gw.handle(CALL, CTX);
    expect(records[0]?.durationMs).toBe(42);
  });
});

describe("JSON-RPC parsing", () => {
  it("refuses a batch rather than half-supporting it", () => {
    const parsed = parseJsonRpc([{ jsonrpc: "2.0", method: "ping" }]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe(RPC_INVALID_REQUEST);
      expect(parsed.error.message).toContain("batches");
    }
  });

  it("refuses anything that is not a 2.0 request", () => {
    for (const body of [
      null,
      "x",
      7,
      {},
      { jsonrpc: "1.0", method: "ping" },
      { jsonrpc: "2.0" },
      { jsonrpc: "2.0", method: "" },
    ]) {
      expect(parseJsonRpc(body).ok, JSON.stringify(body)).toBe(false);
    }
  });

  it("returns a 400 with a null id for an unparseable message", async () => {
    const { gw } = gateway();
    const response = await gw.handle([{ jsonrpc: "2.0" }], CTX);
    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty("id", null);
  });

  it("accepts a well-formed request", () => {
    const parsed = parseJsonRpc(CALL);
    expect(parsed.ok).toBe(true);
  });
});

describe("reading the upstream body", () => {
  it("parses a plain JSON response", () => {
    expect(readRpcBody('{"jsonrpc":"2.0","id":1,"result":{}}')).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {},
    });
  });

  it("reduces an SSE stream to its last data payload", () => {
    const stream = [
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}',
      "",
      "event: message",
      'data: {"jsonrpc":"2.0","id":1,"result":{"a":2}}',
      "",
    ].join("\n");
    expect(readRpcBody(stream)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { a: 2 },
    });
  });

  it("returns undefined for an empty body", () => {
    expect(readRpcBody("")).toBeUndefined();
    expect(readRpcBody("   ")).toBeUndefined();
  });
});

describe("counting tools", () => {
  it("counts a tools/list result and nothing else", () => {
    expect(toolCountOf({ tools: [1, 2, 3] })).toBe(3);
    expect(toolCountOf({ tools: [] })).toBe(0);
    expect(toolCountOf({ content: [] })).toBeUndefined();
    expect(toolCountOf(null)).toBeUndefined();
    expect(toolCountOf("x")).toBeUndefined();
  });
});
