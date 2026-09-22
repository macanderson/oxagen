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
      error: "tools are not supported for this model",
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
