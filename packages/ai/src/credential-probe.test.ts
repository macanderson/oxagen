import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CREDENTIAL_PROBE_TIMEOUT_MS,
  CREDENTIAL_PROBE_URL,
  probeModelCredential,
} from "./credential-probe";

const KEY = "sk-or-v1-abcdef0123456789";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub the global fetch and hand back the mock so a test can read its calls. */
function stubFetch(impl: (...args: unknown[]) => Promise<Response>) {
  const fetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("probeModelCredential — the request", () => {
  it("GETs OpenRouter's key endpoint with the key as a bearer token", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));
    await probeModelCredential({ provider: "openrouter", apiKey: KEY });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(url).toBe(CREDENTIAL_PROBE_URL.openrouter);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
  });

  it("GETs the Vercel AI Gateway model list for a gateway key", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: [] }));
    await probeModelCredential({ provider: "gateway", apiKey: KEY });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/models");
    expect(url).toBe(CREDENTIAL_PROBE_URL.gateway);
  });

  it("does not follow a redirect — the target is a URL the guard never saw", async () => {
    // The handler checked the URL the admin typed. A public endpoint answering
    // 302 to a private host would carry the key past that check, so the probe
    // sends redirect: manual and reports the 3xx as the vendor's answer.
    const fetchMock = stubFetch(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://10.0.0.5/v1/models" },
        }),
    );
    const result = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1",
      toolProbeModel: "m",
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.redirect).toBe("manual");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    expect(result.toolCalling).toBeNull();
    expect(result.error).toContain(
      'redirecting to "http://10.0.0.5/v1/models"',
    );
    expect(result.error).not.toContain(KEY);
  });

  it("bounds the request with a timeout signal", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    await probeModelCredential({ provider: "openrouter", apiKey: KEY });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(CREDENTIAL_PROBE_TIMEOUT_MS).toBe(10_000);
  });

  it("puts the key in the header and nowhere else in the request", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    await probeModelCredential({ provider: "openrouter", apiKey: KEY });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain(KEY);
    expect(init.body).toBeUndefined();
  });
});

describe("probeModelCredential — the answer", () => {
  it("reports ok on a 2xx with no error and a whole-millisecond latency", async () => {
    stubFetch(async () => jsonResponse(200, { data: { label: "my key" } }));
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(result.ok).toBe(true);
    expect(result.error).toBeNull();
    expect(Number.isInteger(result.latencyMs)).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("reports the vendor's error.message on a refusal", async () => {
    stubFetch(async () =>
      jsonResponse(401, { error: { message: "Invalid API key", code: 401 } }),
    );
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(result).toMatchObject({ ok: false, error: "Invalid API key" });
  });

  it("falls back to the status line when the body carries no error.message", async () => {
    stubFetch(async () => jsonResponse(403, { detail: "forbidden" }));
    const result = await probeModelCredential({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(result).toMatchObject({ ok: false, error: "HTTP 403" });
  });

  it("falls back to the status line when the body is not JSON at all", async () => {
    stubFetch(
      async () =>
        new Response("<html>Bad Gateway</html>", {
          status: 502,
          headers: { "content-type": "text/html" },
        }),
    );
    const result = await probeModelCredential({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(result).toMatchObject({ ok: false, error: "HTTP 502" });
  });

  it("reports a thrown network error as the error text rather than throwing", async () => {
    stubFetch(async () => {
      throw new TypeError("fetch failed: getaddrinfo ENOTFOUND");
    });
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("fetch failed: getaddrinfo ENOTFOUND");
  });

  it("reports the timeout signal firing as a failure with its message", async () => {
    stubFetch(async () => {
      throw new DOMException("The operation was aborted", "TimeoutError");
    });
    const result = await probeModelCredential({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe("The operation was aborted");
  });

  it("reports a non-Error throw as text", async () => {
    stubFetch(async () => {
      throw "socket hang up";
    });
    const result = await probeModelCredential({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(result.error).toBe("socket hang up");
  });
});

describe("probeModelCredential — the key never leaves", () => {
  it("scrubs a vendor message that echoes the key", async () => {
    stubFetch(async () =>
      jsonResponse(401, { error: { message: `key ${KEY} is not valid` } }),
    );
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(result.error).toBe("key [redacted] is not valid");
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("scrubs a transport error that echoes the key", async () => {
    stubFetch(async () => {
      throw new Error(`request with Authorization: Bearer ${KEY} failed`);
    });
    const result = await probeModelCredential({
      provider: "gateway",
      apiKey: KEY,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.error).toContain("[redacted]");
  });

  it("takes a credential out of the endpoint a transport error echoes", async () => {
    // What Node actually says when a stored endpoint carries userinfo:
    // "Request cannot be constructed from a URL that includes credentials:
    // <the whole URL>". `assertPublicHttpUrl` refuses such an endpoint now, so
    // this is a row written before that check — and its password would
    // otherwise be handed back as the verification's `error` and shown on the
    // settings page (#3314, finding 3).
    stubFetch(async () => {
      throw new TypeError(
        "Request cannot be constructed from a URL that includes credentials: " +
          "https://acme:hunter2@api.example.com/v1/models",
      );
    });
    const result = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://acme:hunter2@api.example.com/v1",
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(result.error).toContain("https://***@api.example.com/v1/models");
  });

  it("never carries the key in a successful result either", async () => {
    stubFetch(async () => jsonResponse(200, { data: { key: KEY } }));
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});

describe("probeModelCredential — direct vendors and custom endpoints", () => {
  it("authenticates Anthropic with x-api-key, not a bearer token", async () => {
    // A bearer token on Anthropic's native route is a 401 that would tell an
    // operator their perfectly good key is wrong.
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: [] }));
    await probeModelCredential({ provider: "anthropic", apiKey: KEY });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(CREDENTIAL_PROBE_URL.anthropic);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBeDefined();
    expect(headers.Authorization).toBeUndefined();
  });

  it("does not spend a completion asking a known vendor whether it can call tools", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: [] }));
    const out = await probeModelCredential({ provider: "openai", apiKey: KEY });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, toolCalling: true });
  });

  it("probes an openai_compatible key at <baseUrl>/models, with no doubled slash", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: [] }));
    await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1/",
    });
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "https://api.together.xyz/v1/models",
    );
  });

  it("reports toolCalling: true when the endpoint returns a forced tool call", async () => {
    const fetchMock = stubFetch(async (url) =>
      String(url).endsWith("/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(200, {
            choices: [
              { message: { tool_calls: [{ function: { name: "ping" } }] } },
            ],
          }),
    );
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1",
      toolProbeModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    });
    expect(out).toMatchObject({ ok: true, toolCalling: true, error: null });
    // The second request forced the tool, on the model the assistant will use.
    const body = JSON.parse(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
    ) as { model: string; tool_choice: unknown };
    expect(body.model).toBe("meta-llama/Llama-3.3-70B-Instruct-Turbo");
    expect(body.tool_choice).toEqual({
      type: "function",
      function: { name: "ping" },
    });
  });

  it("reports toolCalling: false — with ok still true — when the endpoint answers in prose", async () => {
    // The key works. The endpoint simply cannot drive the assistant, and the
    // operator needs to hear that distinction, not "your key is wrong".
    stubFetch(async (url) =>
      String(url).endsWith("/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(200, {
            choices: [{ message: { content: "pong" } }],
          }),
    );
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://vllm.example.com/v1",
      toolProbeModel: "some-model",
    });
    expect(out).toMatchObject({ ok: true, toolCalling: false });
  });

  it("reports the vendor's reason when it refuses the tools parameter", async () => {
    stubFetch(async (url) =>
      String(url).endsWith("/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(400, {
            error: { message: "tools are not supported for this model" },
          }),
    );
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://vllm.example.com/v1",
      toolProbeModel: "some-model",
    });
    expect(out).toMatchObject({
      ok: true,
      toolCalling: false,
      failingTier: "balanced",
      error: "balanced tier (some-model): tools are not supported for this model",
    });
  });

  it("does not ask the tool question when the key itself was refused", async () => {
    const fetchMock = stubFetch(async () =>
      jsonResponse(401, { error: { message: "bad key" } }),
    );
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://api.together.xyz/v1",
      toolProbeModel: "m",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: false, toolCalling: null });
  });

  it("refuses an openai_compatible probe with no endpoint instead of calling anything", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, {}));
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(false);
  });

  it("scrubs the key from a tool-probe refusal that echoes it", async () => {
    stubFetch(async (url) =>
      String(url).endsWith("/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(400, { error: { message: `rejected key ${KEY}` } }),
    );
    const out = await probeModelCredential({
      provider: "openai_compatible",
      apiKey: KEY,
      baseUrl: "https://vllm.example.com/v1",
      toolProbeModel: "m",
    });
    expect(JSON.stringify(out)).not.toContain(KEY);
  });
});

type Sent = { url: string; body: Record<string, unknown> | null; init: RequestInit };

/** Every request the probe sent, with its JSON body parsed. */
function sent(fetchMock: ReturnType<typeof stubFetch>): Sent[] {
  return fetchMock.mock.calls.map((call) => {
    const [url, init] = call as [string, RequestInit];
    return {
      url: String(url),
      init,
      body:
        typeof init.body === "string"
          ? (JSON.parse(init.body) as Record<string, unknown>)
          : null,
    };
  });
}

const toolCall = () =>
  jsonResponse(200, {
    choices: [
      {
        finish_reason: "tool_calls",
        message: { tool_calls: [{ function: { name: "ping" } }] },
      },
    ],
  });
const prose = () =>
  jsonResponse(200, {
    choices: [{ finish_reason: "stop", message: { content: "pong" } }],
  });

describe("probeModelCredential — every mapped tier (#3314)", () => {
  it("asks each model an openai key maps, once each, at the endpoint the turn uses, and names the tier that fails", async () => {
    const fetchMock = stubFetch(async (url, init) => {
      if (String(url).endsWith("/models")) return jsonResponse(200, { data: [] });
      const body = JSON.parse((init as RequestInit).body as string) as {
        model: string;
      };
      return body.model === "gpt-5-mini" ? toolCall() : prose();
    });
    const out = await probeModelCredential({
      provider: "openai",
      apiKey: KEY,
      toolProbeModels: {
        fast: "gpt-5-mini",
        balanced: "gpt-5.2",
        precise: "gpt-5.2",
      },
    });
    expect(out).toMatchObject({
      ok: true,
      toolCalling: false,
      toolCallingByTier: { fast: true, balanced: false, precise: false },
      failingTier: "balanced",
      structuredOutputs: null,
    });
    const requests = sent(fetchMock);
    // The key read, then one completion per distinct model, never three.
    expect(requests).toHaveLength(3);
    const completions = requests.slice(1);
    expect(completions.map((r) => r.url)).toEqual([
      "https://api.openai.com/v1/chat/completions",
      "https://api.openai.com/v1/chat/completions",
    ]);
    expect(completions.map((r) => r.body?.model).sort()).toEqual([
      "gpt-5-mini",
      "gpt-5.2",
    ]);
    for (const r of completions) {
      expect(
        (r.init.headers as Record<string, string>).Authorization,
      ).toBe(`Bearer ${KEY}`);
      // OpenAI refuses max_tokens on its reasoning models.
      expect(r.body?.max_completion_tokens).toBeGreaterThan(0);
      expect(r.body?.max_tokens).toBeUndefined();
      expect(r.body?.tool_choice).toEqual({
        type: "function",
        function: { name: "ping" },
      });
    }
  });

  it("asks an anthropic key's mapped model on Anthropic's OpenAI-compatible endpoint, as the runtime client does", async () => {
    const fetchMock = stubFetch(async (url) =>
      String(url).endsWith("/models") ? jsonResponse(200, { data: [] }) : toolCall(),
    );
    const out = await probeModelCredential({
      provider: "anthropic",
      apiKey: KEY,
      toolProbeModels: { balanced: "claude-sonnet-4-5" },
    });
    expect(out).toMatchObject({
      ok: true,
      toolCalling: true,
      toolCallingByTier: { balanced: true },
      failingTier: null,
      error: null,
    });
    const [keyRead, completion] = sent(fetchMock);
    // The key read keeps Anthropic's own header; the completion goes where
    // the turn's does, with the bearer token the compatible client sends.
    expect((keyRead!.init.headers as Record<string, string>)["x-api-key"]).toBe(
      KEY,
    );
    expect(completion!.url).toBe("https://api.anthropic.com/v1/chat/completions");
    expect(
      (completion!.init.headers as Record<string, string>).Authorization,
    ).toBe(`Bearer ${KEY}`);
    expect(completion!.body).toMatchObject({
      model: "claude-sonnet-4-5",
      max_tokens: 64,
    });
  });

  it("reports an unanswered question as null when a model runs out of output first", async () => {
    stubFetch(async (url) =>
      String(url).endsWith("/models")
        ? jsonResponse(200, { data: [] })
        : jsonResponse(200, {
            choices: [{ finish_reason: "length", message: { content: "" } }],
          }),
    );
    const out = await probeModelCredential({
      provider: "openai",
      apiKey: KEY,
      toolProbeModels: { balanced: "o4-mini" },
    });
    expect(out).toMatchObject({
      ok: true,
      toolCalling: null,
      toolCallingByTier: { balanced: null },
      failingTier: null,
    });
    expect(out.error).toContain("balanced tier (o4-mini)");
  });

  it("asks nothing past the key of a routed provider, whatever it maps (negative)", async () => {
    const fetchMock = stubFetch(async () => jsonResponse(200, { data: {} }));
    const out = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
      toolProbeModels: { balanced: "anthropic/claude-sonnet-4.5" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out).toMatchObject({ ok: true, toolCalling: true });
  });
});

describe("probeModelCredential — structured outputs on an openai_compatible endpoint (#3314)", () => {
  const BASE = "https://vllm.example.com/v1";
  const probe = (answer: (body: Record<string, unknown>) => Promise<Response>) => {
    const fetchMock = stubFetch(async (url, init) => {
      if (String(url).endsWith("/models")) return jsonResponse(200, { data: [] });
      const body = JSON.parse((init as RequestInit).body as string) as Record<
        string,
        unknown
      >;
      return "tools" in body ? toolCall() : answer(body);
    });
    return {
      fetchMock,
      out: probeModelCredential({
        provider: "openai_compatible",
        apiKey: KEY,
        baseUrl: BASE,
        toolProbeModels: { fast: "llama-8b", balanced: "llama-70b" },
      }),
    };
  };

  it("asks the fast model for a JSON-schema answer, in the SDK's request shape, and records that it matched", async () => {
    const { fetchMock, out } = probe(async () =>
      jsonResponse(200, {
        choices: [{ finish_reason: "stop", message: { content: '{"ok":true}' } }],
      }),
    );
    expect(await out).toMatchObject({
      ok: true,
      toolCalling: true,
      structuredOutputs: true,
    });
    const structured = sent(fetchMock).find(
      (r) => r.body !== null && "response_format" in r.body,
    )!;
    expect(structured.url).toBe(`${BASE}/chat/completions`);
    expect(structured.body).toMatchObject({
      model: "llama-8b",
      response_format: {
        type: "json_schema",
        json_schema: { strict: true, name: "response" },
      },
    });
  });

  it("records false when the endpoint refuses response_format", async () => {
    const { out } = probe(async () =>
      jsonResponse(400, { error: { message: "response_format is not supported" } }),
    );
    expect(await out).toMatchObject({
      ok: true,
      toolCalling: true,
      structuredOutputs: false,
      error: null,
    });
  });

  it("records false when the endpoint ignores the schema and answers in prose", async () => {
    const { out } = probe(async () => prose());
    expect((await out).structuredOutputs).toBe(false);
  });

  it("records null, and still accepts the key, when the question gets no answer", async () => {
    const { out } = probe(async () => {
      throw new Error("socket hang up");
    });
    expect(await out).toMatchObject({ ok: true, structuredOutputs: null });
  });

  it("asks a named vendor no structured-output question (negative)", async () => {
    const fetchMock = stubFetch(async (url) =>
      String(url).endsWith("/models") ? jsonResponse(200, { data: [] }) : toolCall(),
    );
    const out = await probeModelCredential({
      provider: "openai",
      apiKey: KEY,
      toolProbeModels: { fast: "gpt-5-mini" },
    });
    expect(out.structuredOutputs).toBeNull();
    expect(
      sent(fetchMock).some((r) => r.body !== null && "response_format" in r.body),
    ).toBe(false);
  });
});
