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

  it("never carries the key in a successful result either", async () => {
    stubFetch(async () => jsonResponse(200, { data: { key: KEY } }));
    const result = await probeModelCredential({
      provider: "openrouter",
      apiKey: KEY,
    });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });
});
