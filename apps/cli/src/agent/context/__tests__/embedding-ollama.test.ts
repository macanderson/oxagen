/**
 * OllamaEmbeddingClient / probeOllama / createOllamaEmbeddingClient tests.
 * `fetch` is always injected (never the global) so this file makes zero real
 * network calls regardless of what's actually running on localhost:11434.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  OllamaEmbeddingClient,
  probeOllama,
  createOllamaEmbeddingClient,
  OLLAMA_PROVIDER_PREFIX,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_OLLAMA_MODEL,
} from "../embedding-ollama.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  delete process.env["OLLAMA_HOST"];
  delete process.env["OXAGEN_EMBED_MODEL"];
});
afterEach(() => {
  delete process.env["OLLAMA_HOST"];
  delete process.env["OXAGEN_EMBED_MODEL"];
});

describe("OllamaEmbeddingClient", () => {
  it("embed() POSTs {model, prompt} to {host}/api/embeddings", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [0.1, 0.2, 0.3] }));
    const client = new OllamaEmbeddingClient({
      host: "http://localhost:11434",
      model: "nomic-embed-text",
      dimensions: 3,
      timeoutMs: 500,
      fetchImpl,
    });

    await expect(client.embed("hello world")).resolves.toEqual([0.1, 0.2, 0.3]);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/embeddings");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "nomic-embed-text",
      prompt: "hello world",
    });
  });

  it("strips a trailing slash on the host before building the URL", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [1] }));
    const client = new OllamaEmbeddingClient({
      host: "http://localhost:11434/",
      model: "nomic-embed-text",
      dimensions: 1,
      timeoutMs: 500,
      fetchImpl,
    });
    await client.embed("x");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://localhost:11434/api/embeddings",
    );
  });

  it("providerId is ollama:<model>", () => {
    const client = new OllamaEmbeddingClient({
      host: DEFAULT_OLLAMA_HOST,
      model: "mxbai-embed-large",
      dimensions: 1024,
      timeoutMs: 500,
      fetchImpl: vi.fn(),
    });
    expect(client.providerId).toBe(
      `${OLLAMA_PROVIDER_PREFIX}mxbai-embed-large`,
    );
    expect(client.providerId).toBe("ollama:mxbai-embed-large");
    expect(client.dimensions).toBe(1024);
  });

  it("embed() throws on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 404));
    const client = new OllamaEmbeddingClient({
      host: DEFAULT_OLLAMA_HOST,
      model: DEFAULT_OLLAMA_MODEL,
      dimensions: 768,
      timeoutMs: 500,
      fetchImpl,
    });
    await expect(client.embed("x")).rejects.toThrow(/404/);
  });

  it("embed() throws on a malformed body (no embedding array)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "model not found" }));
    const client = new OllamaEmbeddingClient({
      host: DEFAULT_OLLAMA_HOST,
      model: DEFAULT_OLLAMA_MODEL,
      dimensions: 768,
      timeoutMs: 500,
      fetchImpl,
    });
    await expect(client.embed("x")).rejects.toThrow(/malformed/);
  });

  it("embedBatch() preserves order across concurrent per-text calls", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async (_url: string, init: RequestInit) => {
        const { prompt } = JSON.parse(init.body as string) as {
          prompt: string;
        };
        // Resolve "b" before "a" to prove Promise.all preserves input order
        // regardless of resolution order.
        if (prompt === "a") await new Promise((r) => setTimeout(r, 5));
        return jsonResponse({ embedding: [prompt.charCodeAt(0)] });
      });
    const client = new OllamaEmbeddingClient({
      host: DEFAULT_OLLAMA_HOST,
      model: DEFAULT_OLLAMA_MODEL,
      dimensions: 1,
      timeoutMs: 500,
      fetchImpl,
    });

    await expect(client.embedBatch(["a", "b", "c"])).resolves.toEqual([
      ["a".charCodeAt(0)],
      ["b".charCodeAt(0)],
      ["c".charCodeAt(0)],
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("embedBatch([]) makes no calls", async () => {
    const fetchImpl = vi.fn();
    const client = new OllamaEmbeddingClient({
      host: DEFAULT_OLLAMA_HOST,
      model: DEFAULT_OLLAMA_MODEL,
      dimensions: 768,
      timeoutMs: 500,
      fetchImpl,
    });
    await expect(client.embedBatch([])).resolves.toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("probeOllama", () => {
  it("returns dimensions from a successful probe response", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: new Array(768).fill(0) }));
    await expect(probeOllama({ fetchImpl })).resolves.toEqual({
      dimensions: 768,
    });
  });

  it("returns null when the fetch rejects (server unreachable)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(probeOllama({ fetchImpl })).resolves.toBeNull();
  });

  it("returns null on a timeout (AbortError)", async () => {
    const fetchImpl = vi.fn().mockImplementation(() => {
      const err = new Error("The operation was aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    await expect(probeOllama({ fetchImpl, timeoutMs: 10 })).resolves.toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false, 500));
    await expect(probeOllama({ fetchImpl })).resolves.toBeNull();
  });

  it("returns null on a malformed body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: "not-an-array" }));
    await expect(probeOllama({ fetchImpl })).resolves.toBeNull();
  });

  it("uses OLLAMA_HOST and OXAGEN_EMBED_MODEL env vars when set", async () => {
    process.env["OLLAMA_HOST"] = "http://example.internal:9999";
    process.env["OXAGEN_EMBED_MODEL"] = "custom-model";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [1, 2] }));
    await probeOllama({ fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://example.internal:9999/api/embeddings");
    expect(JSON.parse(init.body as string).model).toBe("custom-model");
  });

  it("explicit opts win over env vars", async () => {
    process.env["OLLAMA_HOST"] = "http://example.internal:9999";
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [1] }));
    await probeOllama({ fetchImpl, host: "http://explicit:1234" });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      "http://explicit:1234/api/embeddings",
    );
  });

  it("falls back to DEFAULT_OLLAMA_HOST / DEFAULT_OLLAMA_MODEL when nothing is set", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [1] }));
    await probeOllama({ fetchImpl });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${DEFAULT_OLLAMA_HOST}/api/embeddings`);
    expect(JSON.parse(init.body as string).model).toBe(DEFAULT_OLLAMA_MODEL);
  });
});

describe("createOllamaEmbeddingClient", () => {
  it("returns a ready client whose dimensions come from the probe", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ embedding: new Array(768).fill(0.01) }),
      );
    const client = await createOllamaEmbeddingClient({ fetchImpl });
    expect(client).not.toBeNull();
    expect(client?.dimensions).toBe(768);
    expect(client?.providerId).toBe(
      `${OLLAMA_PROVIDER_PREFIX}${DEFAULT_OLLAMA_MODEL}`,
    );
  });

  it("returns null when unreachable", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      createOllamaEmbeddingClient({ fetchImpl }),
    ).resolves.toBeNull();
  });

  it("the returned client reuses the same fetchImpl for subsequent embeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ embedding: [1, 2] }));
    const client = await createOllamaEmbeddingClient({
      fetchImpl,
      host: "http://h:1",
    });
    fetchImpl.mockClear();
    await client?.embed("second call");
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://h:1/api/embeddings");
  });
});
