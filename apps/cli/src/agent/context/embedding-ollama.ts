/**
 * Ollama-backed embedding client (local, free, offline, AI-SDK-free).
 *
 * Talks to a locally-running Ollama server (https://ollama.com) over plain
 * HTTP — no `@ai-sdk/*` dependency, no API key, no bundling concern (Ollama is
 * a separate process the user installs and runs; the CLI only ever speaks
 * HTTP to it, so there is nothing native to bundle here — contrast
 * embedding-onnx.ts, which runs a model in-process). This makes it the
 * lowest-risk local provider and the first tier `auto` mode tries.
 *
 * Its vectors live in a different vector space than the platform gateway's
 * 1536-d `text-embedding-3-small` index (dimension varies by model — 768 for
 * the default `nomic-embed-text`). They remain in the checkout-local graph,
 * where the provider id prevents incompatible vector spaces from being
 * compared (see embedding.ts).
 */
import type { EmbeddingClient } from "./embedding-types.js";

/** Prefix on every Ollama-produced `providerId`, e.g. "ollama:nomic-embed-text". */
export const OLLAMA_PROVIDER_PREFIX = "ollama:";

export const DEFAULT_OLLAMA_HOST = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "nomic-embed-text";

/** Short — this probe gates whether `auto` mode even considers Ollama a candidate. */
const DEFAULT_PROBE_TIMEOUT_MS = 800;

export interface OllamaClientOptions {
  /** Overrides `OLLAMA_HOST`, then {@link DEFAULT_OLLAMA_HOST}. */
  host?: string;
  /** Overrides `OXAGEN_EMBED_MODEL`, then {@link DEFAULT_OLLAMA_MODEL}. */
  model?: string;
  /** Per-request timeout (ms). Defaults to {@link DEFAULT_PROBE_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Injectable fetch (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function resolveHost(opts: OllamaClientOptions): string {
  return opts.host ?? process.env["OLLAMA_HOST"] ?? DEFAULT_OLLAMA_HOST;
}

function resolveModel(opts: OllamaClientOptions): string {
  return (
    opts.model ?? process.env["OXAGEN_EMBED_MODEL"] ?? DEFAULT_OLLAMA_MODEL
  );
}

interface OllamaEmbedResponse {
  embedding?: unknown;
}

/**
 * One raw call to Ollama's `/api/embeddings`. Throws on any non-2xx response,
 * timeout, connection failure, or malformed body — callers translate that into
 * "unavailable" rather than propagating a raw fetch error.
 */
async function callEmbed(
  host: string,
  model: string,
  prompt: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<number[]> {
  const res = await fetchImpl(`${host.replace(/\/+$/, "")}/api/embeddings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok)
    throw new Error(`ollama embeddings request failed: ${res.status}`);
  const body = (await res.json()) as OllamaEmbedResponse;
  if (!Array.isArray(body.embedding) || body.embedding.length === 0) {
    throw new Error(
      "ollama embeddings: malformed response (no embedding array)",
    );
  }
  return body.embedding as number[];
}

/** A local Ollama-backed {@link EmbeddingClient}. Construct via {@link createOllamaEmbeddingClient}. */
export class OllamaEmbeddingClient implements EmbeddingClient {
  readonly providerId: string;
  readonly dimensions: number;
  private readonly host: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: {
    host: string;
    model: string;
    dimensions: number;
    timeoutMs: number;
    fetchImpl: typeof fetch;
  }) {
    this.host = opts.host;
    this.model = opts.model;
    this.dimensions = opts.dimensions;
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetchImpl;
    this.providerId = `${OLLAMA_PROVIDER_PREFIX}${opts.model}`;
  }

  embed(text: string): Promise<number[]> {
    return callEmbed(
      this.host,
      this.model,
      text,
      this.fetchImpl,
      this.timeoutMs,
    );
  }

  /**
   * Ollama's long-standing `/api/embeddings` endpoint takes one prompt per
   * call — there is no batch endpoint on every shipped Ollama version (the
   * newer `/api/embed` accepts an array, but only on recent servers). Firing
   * the sequential calls concurrently via `Promise.all` keeps this correct on
   * every version while still overlapping the I/O; order is preserved by
   * `Promise.all` regardless of resolution order.
   */
  embedBatch(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((t) => this.embed(t)));
  }
}

export interface OllamaProbeResult {
  /** The embedding width of `opts.model` on this server, discovered live. */
  dimensions: number;
}

/**
 * Reachability probe: one tiny embed call. Success tells us both "Ollama is up
 * and this model is pulled" AND the vector width in a single round trip —
 * `EmbeddingClient.dimensions` must be known synchronously for the client's
 * whole lifetime (callers compare it against a persisted vector's length
 * before ever calling `embed()`), so the probe response IS the dimension
 * discovery, not a separate step. Returns `null` on any failure (server down,
 * wrong port, model not pulled, timeout) — `auto` mode reads that as "not a
 * candidate" and moves to the next tier.
 */
export async function probeOllama(
  opts: OllamaClientOptions = {},
): Promise<OllamaProbeResult | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const host = resolveHost(opts);
  const model = resolveModel(opts);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  try {
    const vec = await callEmbed(host, model, "ping", fetchImpl, timeoutMs);
    return { dimensions: vec.length };
  } catch {
    return null;
  }
}

/**
 * Resolve a ready-to-use Ollama embedding client, or `null` when no local
 * Ollama server answers within the probe timeout. The probe's discovered
 * dimension becomes the client's permanent {@link EmbeddingClient.dimensions}.
 */
export async function createOllamaEmbeddingClient(
  opts: OllamaClientOptions = {},
): Promise<OllamaEmbeddingClient | null> {
  const probe = await probeOllama(opts);
  if (!probe) return null;
  return new OllamaEmbeddingClient({
    host: resolveHost(opts),
    model: resolveModel(opts),
    dimensions: probe.dimensions,
    timeoutMs: opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
    fetchImpl: opts.fetchImpl ?? fetch,
  });
}
