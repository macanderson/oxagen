import { describe, expect, it, vi } from "vitest";
import {
  ceilingOf,
  CLAUDE_CODE_TOOL_USE_ID_META,
  createMcpGateway,
  filterToolsByMandate,
  gatewayToolsOf,
  outcomeOf,
  type GatewayAttribution,
  type GatewayCallRecord,
  type GatewayFetch,
  type McpGatewayDeps,
  parseJsonRpc,
  readRpcBody,
  refusalRulesOf,
  RPC_INVALID_REQUEST,
  RPC_REFUSED,
  toolCountOf,
  tooManyToolsMessage,
  toolUseIdOf,
} from "./mcp-gateway";
import { digestJcs, jcs, jsonByteLength } from "../digest";
import { jsonContent } from "../evidence/frame-body";
import { policyBundleSchema, type PolicyBundle } from "../wire";
import { unsignedBundle } from "../host/test-support";

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
    expect(body.error.message).toContain("no Oxagen mandate");
    // Nothing was forwarded and nothing was recorded under nobody's name.
    expect(records).toEqual([]);
    expect(logs.join(" ")).toContain("no enrollment");
    expect(logs.join(" ")).toContain("gateway credential");
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

  it("names the daemon chain so the control plane can correlate the call", async () => {
    // #3221. The control plane knows from the credential WHICH HOST it is
    // serving; it cannot know which of that host's chains. Until this header
    // existed the answer came from an attribute on the submitted batch, so
    // anything able to submit a batch chose it — and a real observation could
    // be pointed at any session, including an invented one.
    const { fetch, calls } = remote({ content: [] });
    const { gw } = gateway({
      fetch,
      attribution: () => attribution({ chainSessionUuid: "tachod-abc" }),
    });
    await gw.handle(CALL, CTX);
    expect(calls[0]?.init.headers["x-tacho-gateway-session"]).toBe(
      "tachod-abc",
    );
  });

  it("omits the chain header when the daemon has no chain yet", async () => {
    // The honest answer rather than a placeholder: the control plane records
    // an invocation it cannot attribute to a chain, and the tier stays on the
    // host's own mode. A fabricated id would be a correlation nobody made.
    const { fetch, calls } = remote({ content: [] });
    const { gw } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(calls[0]?.init.headers).not.toHaveProperty(
      "x-tacho-gateway-session",
    );
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
  /**
   * Built through `policyBundleSchema.parse`, not cast past it. The test used
   * to hand `ceilingOf` a bare `{ tool_ceiling }` object through
   * `as unknown as PolicyBundle`, which is why the ceiling looked covered
   * while the strict schema had no such field and rejected every real bundle
   * that carried one. A fixture the schema accepts is the only one that
   * proves anything here.
   */
  const bundle = (maxTools: number): PolicyBundle =>
    policyBundleSchema.parse({
      ...unsignedBundle({
        tool_ceiling: {
          model_id: "openai/gpt-5",
          max_tools: maxTools,
          source: "OpenAI function-calling limit of 128 tools per request",
        },
      }),
      signature: { key_id: "k1", alg: "ed25519", sig: "sig" },
    });

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

  it("reads the ceiling a bundle declares, and none when it declares none", () => {
    expect(ceilingOf(undefined)).toBeUndefined();
    expect(ceilingOf({} as PolicyBundle)).toBeUndefined();
    expect(ceilingOf(bundle(128))).toEqual({
      modelId: "openai/gpt-5",
      maxTools: 128,
      source: "OpenAI function-calling limit of 128 tools per request",
    });
  });

  it("parses a signed bundle that declares a ceiling, and rejects a half-declared one", () => {
    const signature = { key_id: "k1", alg: "ed25519", sig: "sig" } as const;
    // The whole point of putting the field in the schema: before this, a
    // control plane that started signing `tool_ceiling` would have had every
    // enrolled host reject the entire mandate, because the schema is strict.
    expect(() =>
      policyBundleSchema.parse({
        ...unsignedBundle({
          tool_ceiling: {
            model_id: "openai/gpt-5",
            max_tools: 128,
            source: "the OpenAI limit",
          },
        }),
        signature,
      }),
    ).not.toThrow();
    // And a ceiling missing its number is not a ceiling with an unknown
    // number — the schema refuses it rather than leaving `ceilingOf` to guess.
    expect(() =>
      policyBundleSchema.parse({
        ...unsignedBundle({
          tool_ceiling: { model_id: "openai/gpt-5" },
        } as never),
        signature,
      }),
    ).toThrow();
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
        inputDigest: digestJcs({ q: "x" }),
        inputBytes: 9,
        outputDigest: digestJcs({ content: [] }),
        outputBytes: 14,
        content: jsonContent(
          jcs({ input: { q: "x" }, output: { content: [] } }),
        ),
      },
    ]);
  });

  it("carries the tool-use id Claude Code names in _meta, and forwards the request untouched", async () => {
    const { fetch, calls } = remote({ content: [] });
    const { gw, records } = gateway({ fetch });
    const call = {
      ...CALL,
      params: {
        ...CALL.params,
        _meta: { [CLAUDE_CODE_TOOL_USE_ID_META]: "toolu_01AbC" },
      },
    };
    await gw.handle(call, CTX);
    expect(records[0]?.toolUseId).toBe("toolu_01AbC");
    expect(JSON.parse(calls[0]?.init.body ?? "{}")).toEqual(call);
    // A call with no `_meta` names no id, and the record carries none.
    await gw.handle(CALL, CTX);
    expect(records[1]).not.toHaveProperty("toolUseId");
  });

  it("reads no tool-use id the envelope would refuse", () => {
    const meta = (id: unknown) => ({
      _meta: { [CLAUDE_CODE_TOOL_USE_ID_META]: id },
    });
    expect(toolUseIdOf(undefined)).toBeUndefined();
    expect(toolUseIdOf({ _meta: null })).toBeUndefined();
    expect(toolUseIdOf({ _meta: "toolu_1" })).toBeUndefined();
    expect(toolUseIdOf(meta(7))).toBeUndefined();
    expect(toolUseIdOf(meta(""))).toBeUndefined();
    expect(toolUseIdOf(meta("t".repeat(513)))).toBeUndefined();
    expect(toolUseIdOf(meta("t".repeat(512)))).toBe("t".repeat(512));
  });

  it("records the arguments and the result, so the call replays", async () => {
    const result = { content: [{ type: "text", text: "42 nodes" }] };
    const { fetch } = remote(result);
    const { gw, records } = gateway({ fetch });
    const args = { q: "MATCH (n) RETURN count(n)", limit: 10 };
    await gw.handle(
      { ...CALL, params: { ...CALL.params, arguments: args } },
      CTX,
    );

    const [record] = records;
    // The digests are the ones the `tool_input_digest` and
    // `tool_output_digest` columns carry, computed the way a hook computes
    // them, so a reader cannot tell which seam produced the frame.
    expect(record?.inputDigest).toBe(digestJcs(args));
    expect(record?.outputDigest).toBe(digestJcs(result));
    expect(record?.inputBytes).toBe(jsonByteLength(args));
    expect(record?.outputBytes).toBe(jsonByteLength(result));

    // One body carries both halves, because a frame carries at most one body.
    expect(record?.content?.content_type).toBe("application/json");
    const body = Buffer.from(record!.content!.bytes).toString("utf8");
    expect(JSON.parse(body)).toEqual({ input: args, output: result });
    // The bytes are the JCS text the digest of the whole body will name.
    expect(body).toBe(jcs({ input: args, output: result }));
  });

  it("records what a rejected call was asked, and the refusal it got back", async () => {
    const error = { code: -32002, message: "Tool blocked by workspace policy" };
    const fetch: GatewayFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: "2.0", id: 7, error }),
    });
    const { gw, records } = gateway({ fetch });
    await gw.handle(CALL, CTX);

    const [record] = records;
    expect(record?.status).toBe("rejected");
    // The arguments are the whole evidence of what was attempted, so a call
    // the control plane turned down is not a blank row.
    expect(record?.inputDigest).toBe(digestJcs({ q: "x" }));
    // A JSON-RPC answer is a result or an error. The refusal is the outcome.
    expect(record?.outputDigest).toBe(digestJcs(error));
    expect(
      JSON.parse(Buffer.from(record!.content!.bytes).toString("utf8")),
    ).toEqual({ input: { q: "x" }, output: error });
  });

  it("records a call whose arguments have no JCS form, minus the arguments", async () => {
    const { fetch } = remote({ content: [] });
    const { gw, records, logs } = gateway({ fetch });
    // A BigInt has no JSON form and so no JCS form. Nothing that arrives over
    // HTTP can carry one, so this is the guard rather than a case: a value
    // `jcs` throws on must leave the frame poorer, never take the call down
    // with it.
    await gw.handle(
      { ...CALL, params: { name: "t", arguments: { size: 1n } } },
      CTX,
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.inputDigest).toBeUndefined();
    expect(logs.join(" ")).toContain("without its arguments");
  });

  it("records a call that carried no arguments without an empty body", async () => {
    const { fetch } = remote({ content: [] });
    const { gw, records } = gateway({ fetch });
    await gw.handle(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ping" } },
      CTX,
    );
    expect(records[0]?.inputDigest).toBeUndefined();
    expect(records[0]?.inputBytes).toBeUndefined();
    expect(
      JSON.parse(Buffer.from(records[0]!.content!.bytes).toString("utf8")),
    ).toEqual({ output: { content: [] } });
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
    // The refusal named no rule, so the record names none.
    expect(records[0]).not.toHaveProperty("ruleIds");
  });

  it("records the rules a refusal names, in order, and none from any other answer (#3971)", async () => {
    const answer = (error: unknown) => {
      const fetch: GatewayFetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 7, error }),
      });
      return gateway({ fetch });
    };
    const refused = answer({
      code: RPC_REFUSED,
      message: "refunds over $500 need a person",
      data: { ruleIds: ["refund-cap", "", 7, "weekend-freeze"] },
    });
    await refused.gw.handle(CALL, CTX);
    expect(refused.records[0]?.ruleIds).toEqual([
      "refund-cap",
      "weekend-freeze",
    ]);
    // A tool failure is not a decision, whatever its data says.
    const failed = answer({
      code: -32603,
      message: "handler threw",
      data: { ruleIds: ["refund-cap"] },
    });
    await failed.gw.handle(CALL, CTX);
    expect(failed.records[0]?.status).toBe("error");
    expect(failed.records[0]).not.toHaveProperty("ruleIds");
  });

  it("reads a refusal's rules within the envelope's bounds (negative)", () => {
    const refusal = (data: unknown) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      error: { code: RPC_REFUSED, message: "denied", data },
    });
    expect(refusalRulesOf(refusal({ ruleIds: [] }))).toBeUndefined();
    expect(refusalRulesOf(refusal({ ruleIds: "refund-cap" }))).toBeUndefined();
    expect(refusalRulesOf(refusal(null))).toBeUndefined();
    expect(refusalRulesOf(undefined)).toBeUndefined();
    const many = refusalRulesOf(
      refusal({ ruleIds: Array.from({ length: 80 }, () => "r".repeat(600)) }),
    );
    expect(many).toHaveLength(64);
    expect(many?.[0]).toHaveLength(512);
  });

  it("records an ordinary tool failure as an error, not as a refusal", async () => {
    // The daemon seals `rejected` as a policy_decision / deny / kernel and the
    // desktop counts it as refused, so only -32002 may earn it. An unknown tool
    // (-32601) or bad arguments (-32602) is the tool failing, not the mandate
    // speaking, and filing it as a refusal invents a governance decision nobody
    // made.
    for (const code of [-32601, -32602, -32603]) {
      const fetch: GatewayFetch = async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            error: { code, message: "no such tool" },
          }),
      });
      const { gw, records } = gateway({ fetch });
      await gw.handle(CALL, CTX);
      expect(records[0]?.status).toBe("error");
    }
  });

  it("records a non-2xx answer with no rpc error as an error, not as a success", async () => {
    // "no `error` member" used to read as success, so a control plane 502 that
    // answered with a plain body was recorded as a tool call that worked.
    const fetch: GatewayFetch = async () => ({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({ message: "bad gateway" }),
    });
    const { gw, records } = gateway({ fetch });
    await gw.handle(CALL, CTX);
    expect(records[0]?.status).toBe("error");
  });

  it("classifies an outcome from the status and the rpc error together", () => {
    expect(outcomeOf(200, undefined)).toBe("ok");
    expect(outcomeOf(202, undefined)).toBe("ok");
    expect(outcomeOf(500, undefined)).toBe("error");
    expect(
      outcomeOf(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: RPC_REFUSED, message: "denied" },
      }),
    ).toBe("rejected");
    expect(
      outcomeOf(200, {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "no such method" },
      }),
    ).toBe("error");
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

/**
 * The gateway presents its own credential, never the host's. The host key
 * reports events and fetches the mandate; it passes every role gate because an
 * API-key principal has no org_users row to check. Forwarding a connected
 * app's tool calls with it handed that app the enrolling admin's authority,
 * which is what `machineKeyDenial` and this split close (ADR-078).
 */
describe("the gateway's credential is not the host's", () => {
  it("presents the gateway key when the host has one", async () => {
    const { fetch, calls } = remote({ content: [] });
    const { gw } = gateway({
      fetch,
      attribution: () => attribution({ apiKey: "oxa_gateway_only" }),
    });
    await gw.handle(CALL, CTX);
    expect(calls[0]?.init.headers["Authorization"]).toBe(
      "Bearer oxa_gateway_only",
    );
  });

  it("serves nothing rather than falling back to a host key", async () => {
    // A host enrolled before the gateway existed has no gateway credential.
    // The daemon returns no attribution for it, and the gateway refuses --
    // it never reaches for whatever other key is lying around.
    const upstream = vi.fn();
    const { gw, records } = gateway({
      attribution: () => undefined,
      fetch: upstream as unknown as GatewayFetch,
    });
    const response = await gw.handle(CALL, CTX);
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(records).toEqual([]);
    expect(
      (response.body as { error: { message: string } }).error.message,
    ).toContain("no Oxagen mandate");
  });
});

describe("tools/list is served through the gateway mandate", () => {
  /**
   * The gateway key's mandate is narrower than the workspace toolbelt the
   * control plane advertises — `gatewayMayInvoke` allows only an `mcp`
   * capability that does not mutate and is not high-sensitivity — and it was
   * applied at `tools/call` only. So the connected app was shown tools that
   * could only fail when selected, and `tool_ceiling` was counted against a
   * list including tools the mandate forbids.
   *
   * The rule itself stays on the control plane: `@oxagen/tacho` takes no
   * `@oxagen/*` runtime dependency, so it cannot read a capability's surfaces,
   * mutation or sensitivity. The bundle carries the rule's answer.
   */
  const bundleWith = (
    overrides: Partial<Omit<PolicyBundle, "signature">>,
  ): PolicyBundle =>
    policyBundleSchema.parse({
      ...unsignedBundle(overrides),
      signature: { key_id: "k1", alg: "ed25519", sig: "sig" },
    });

  const named = (...names: string[]) => ({
    tools: names.map((name) => ({ name, description: `${name} tool` })),
  });

  const LIST = { jsonrpc: "2.0" as const, id: 1, method: "tools/list" };

  it("serves only the tools the mandate permits", async () => {
    const { fetch } = remote(
      named("query_ontology", "delete_workspace", "reveal_secret"),
    );
    const { gw, logs } = gateway({
      fetch,
      bundle: () => bundleWith({ gateway_tools: ["query_ontology"] }),
    });
    const response = await gw.handle(LIST, CTX);
    expect((response.body as { result: { tools: unknown[] } }).result).toEqual(
      named("query_ontology"),
    );
    expect(logs.join(" ")).toContain("filtered tools/list to the mandate");
  });

  it("counts the ceiling against what it will serve, not what it was handed", async () => {
    // A list that fits once the forbidden tools are gone is served. Before,
    // the forbidden tools were counted, so a mandate whose toolbelt fit was
    // refused for a size it never had.
    const { fetch } = remote(
      named("allowed_one", "allowed_two", "forbidden_one", "forbidden_two"),
    );
    const { gw } = gateway({
      fetch,
      bundle: () =>
        bundleWith({
          gateway_tools: ["allowed_one", "allowed_two"],
          tool_ceiling: {
            model_id: "openai/gpt-5",
            max_tools: 2,
            source: "OpenAI function-calling limit",
          },
        }),
    });
    const response = await gw.handle(LIST, CTX);
    expect((response.body as { result: { tools: unknown[] } }).result).toEqual(
      named("allowed_one", "allowed_two"),
    );
    expect(response.body).not.toHaveProperty("error");
  });

  it("still refuses when the permitted tools alone overflow the ceiling", async () => {
    const { fetch } = remote(named("a", "b", "c", "d"));
    const { gw } = gateway({
      fetch,
      bundle: () =>
        bundleWith({
          gateway_tools: ["a", "b", "c"],
          tool_ceiling: {
            model_id: "openai/gpt-5",
            max_tools: 2,
            source: "OpenAI function-calling limit",
          },
        }),
    });
    const error = (
      (await gw.handle(LIST, CTX)).body as {
        error: { code: number; message: string; data: unknown };
      }
    ).error;
    expect(error.code).toBe(RPC_REFUSED);
    // Three, not four: the count names the list as it would have been served.
    expect(error.message).toContain("3 tools");
    expect(error.data).toMatchObject({ toolCount: 3 });
  });

  it("serves nothing when the mandate permits nothing", async () => {
    const { fetch } = remote(named("query_ontology"));
    const { gw } = gateway({
      fetch,
      bundle: () => bundleWith({ gateway_tools: [] }),
    });
    expect((await gw.handle(LIST, CTX)).body).toMatchObject({
      result: { tools: [] },
    });
  });

  it("serves what it is given when the bundle names no allowance", async () => {
    // Absent is *not told*, not *none permitted*. A bundle signed before the
    // field existed must not take a working machine's toolbelt to zero.
    const { fetch } = remote(named("query_ontology", "delete_workspace"));
    const { gw, logs } = gateway({ fetch, bundle: () => bundleWith({}) });
    expect((await gw.handle(LIST, CTX)).body).toMatchObject({
      result: named("query_ontology", "delete_workspace"),
    });
    expect(logs.join(" ")).not.toContain("filtered tools/list");
  });

  it("leaves a tools/call alone — the kernel is what refuses one", async () => {
    const { fetch } = remote({ content: [{ type: "text", text: "ok" }] });
    const { gw } = gateway({
      fetch,
      bundle: () => bundleWith({ gateway_tools: [] }),
    });
    expect((await gw.handle(CALL, CTX)).body).toHaveProperty("result");
  });

  it("parses a bundle that declares an allowance, and reads it back", () => {
    // The schema is strict, so a host that did not name the field would
    // reject the whole mandate the day the control plane started signing one.
    expect(gatewayToolsOf(undefined)).toBeUndefined();
    expect(gatewayToolsOf(bundleWith({}))).toBeUndefined();
    expect(gatewayToolsOf(bundleWith({ gateway_tools: ["a", "b"] }))).toEqual(
      new Set(["a", "b"]),
    );
    expect(gatewayToolsOf(bundleWith({ gateway_tools: [] }))?.size).toBe(0);
  });

  it("leaves a result it cannot read untouched", () => {
    const allowed = new Set(["a"]);
    expect(filterToolsByMandate(undefined, allowed)).toBeUndefined();
    expect(filterToolsByMandate({ nope: 1 }, allowed)).toEqual({ nope: 1 });
    // A nameless entry is not a tool the mandate named, so it does not survive.
    expect(
      filterToolsByMandate({ tools: [{}, { name: "a" }] }, allowed),
    ).toEqual({ tools: [{ name: "a" }] });
    const untouched = { tools: [{ name: "a" }] };
    expect(filterToolsByMandate(untouched, undefined)).toBe(untouched);
    expect(filterToolsByMandate(untouched, allowed)).toBe(untouched);
  });
});
