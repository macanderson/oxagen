// embedder.ts: turn search entries into vectors at an embeddings endpoint
// (lane M15; mcp-studio-spec, Large servers; ADR-217).
//
// The request goes through the cloud Transport, so a custom endpoint gets
// the same address checks as a tool call: no private, loopback, or
// link-local address, and no redirect to another host. The key goes in the
// Authorization header only. No message this module builds carries the key,
// the endpoint's url, or any part of the endpoint's response body.
//
// These requests do not go through @oxagen/ai (ADR-217), so the caller meters
// them: the embedder opens the caller's meter before each request. It closes
// it with the token count once the endpoint answers 2xx, or as failed when
// the endpoint refuses the request or never answers.
import { concat, decodeText, encodeText, parseJson } from "../execute/body";
import { createCloudTransport } from "../execute/cloud/transport";
import { parseEndpoint } from "../execute/endpoint";
import { httpTarget } from "../execute/http-call";
import { Clock, type Stop } from "../execute/retry";
import {
  TransportError,
  type HeaderEntry,
  type HttpTarget,
  type HttpTransportResponse,
  type Transport,
} from "../execute/transport";
import { isList, isRecord } from "../execute/util";

/** document for an entry publish stores, query for the text an agent searched with. */
export type EmbedPurpose = "document" | "query";

/** Something that turns text into vectors. The key names where the vectors come from. */
export interface Embedder {
  /** The target key. Vectors under one key can be compared with each other and with nothing else. */
  readonly key: string;
  /** One vector per text, in the order given. Throws a SearchIndexError when it cannot. */
  embed(texts: readonly string[], purpose: EmbedPurpose, signal?: AbortSignal): Promise<Float32Array[]>;
}

export const SEARCH_INDEX_ERROR_CODES = [
  "no_key",
  "unreachable",
  "refused",
  "malformed",
  "timeout",
  "cancelled",
  "incomplete",
] as const;
export type SearchIndexErrorCode = (typeof SEARCH_INDEX_ERROR_CODES)[number];

/**
 * Why search could not rank by embeddings. Search then ranks by keyword, so
 * this error never reaches the agent.
 *
 * - no_key: the provider needs a key, and none is set.
 * - unreachable: the endpoint did not answer, or answered with an error status.
 * - refused: the endpoint refused the key, or the address checks refused the endpoint.
 * - malformed: the endpoint's response is not a list of vectors, one per entry.
 * - timeout: the endpoint did not answer before the deadline.
 * - cancelled: the caller stopped waiting.
 * - incomplete: an entry has no vector, or its vector cannot be compared with the query's.
 */
export class SearchIndexError extends Error {
  readonly code: SearchIndexErrorCode;
  /** The endpoint's HTTP status, when it answered with one. */
  readonly status: number | null;

  constructor(code: SearchIndexErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "SearchIndexError";
    this.code = code;
    this.status = status;
  }
}

/** What one embeddings request used. The caller records it, because @oxagen/ai does not see the request. */
export interface EmbedUsage {
  /** The texts the request carried, in order. */
  texts: readonly string[];
  purpose: EmbedPurpose;
  /** The endpoint's usage.total_tokens, or null when its response gives no count. */
  tokens: number | null;
  /** How long the request took, in milliseconds. */
  durationMs: number;
}

/**
 * One request's meter. The embedder opens it before the request and calls
 * exactly one of these once the request ends. Neither may throw.
 */
export interface EmbedMeter {
  /**
   * The endpoint answered 2xx, so it did the work, and this is what it
   * reported using. It runs even when the vectors are then refused, and
   * `tokens` is null when the answer carried no readable count.
   */
  used(usage: EmbedUsage): void;
  /** The endpoint refused the request or never answered, so it reports no usage. */
  failed(): void;
}

/** What post() learned about the answer, filled in as it arrives. */
interface Answer {
  /** True once the endpoint answered 2xx. */
  answered: boolean;
  /** The answer's usage.total_tokens, once its body parsed. */
  tokens: number | null;
}

/** How long one embeddings request may take. */
export const EMBED_DEADLINE_MS = 10_000;

/** The most bytes one embeddings response may hold: 128 vectors of 4,096 numbers, with room for JSON. */
export const MAX_EMBED_RESPONSE_BYTES = 24 * 1024 * 1024;

/** The most numbers one vector may hold. mcp.search_embeddings refuses a longer one. */
export const MAX_DIMENSIONS = 4096;

export interface HttpEmbedderOptions {
  url: string;
  model: string;
  /** The target key, from targetKey(). */
  key: string;
  /** The endpoint's key, sent as a Bearer token, or null for an endpoint that takes none. */
  apiKey: string | null;
  /** True to send input_type, which Voyage AI reads. A custom endpoint may not accept it. */
  inputType: boolean;
  /**
   * Opens a meter before each request is sent, so the usage is on record
   * before the endpoint spends it. It must not reject.
   */
  meter?: () => Promise<EmbedMeter>;
  /** The cloud Transport by default. A test passes a fake. */
  transport?: Pick<Transport, "http">;
  deadlineMs?: number;
  maxResponseBytes?: number;
}

/**
 * An Embedder that POSTs `{model, input}` to an endpoint that answers with
 * `{data: [{index, embedding}]}`: Voyage AI's shape, which OpenAI's also fits.
 */
export function httpEmbedder(options: HttpEmbedderOptions): Embedder {
  let transport = options.transport;
  const deadlineMs = options.deadlineMs ?? EMBED_DEADLINE_MS;
  const limit = options.maxResponseBytes ?? MAX_EMBED_RESPONSE_BYTES;

  async function post(
    sender: Pick<Transport, "http">,
    target: HttpTarget,
    texts: readonly string[],
    purpose: EmbedPurpose,
    signal: AbortSignal | undefined,
    answer: Answer,
  ): Promise<Float32Array[]> {
    const headers: HeaderEntry[] = [
      ["content-type", "application/json"],
      ["accept", "application/json"],
    ];
    if (options.apiKey !== null) headers.push(["authorization", `Bearer ${options.apiKey}`]);
    const body = { model: options.model, input: texts, ...(options.inputType ? { input_type: purpose } : {}) };
    const controller = new AbortController();
    const clock = new Clock(Date.now() + deadlineMs, signal ?? controller.signal, controller);
    try {
      const sent = await clock.race(
        sender.http({
          network: "cloud",
          deadline_ms: deadlineMs,
          signal: controller.signal,
          relay_credential: undefined,
          target,
          headers,
          body: encodeText(JSON.stringify(body)),
        }),
      );
      if (sent.kind === "stopped") throw stopped(sent.stop);
      if (sent.kind === "failed") throw sendFailure(sent.error);
      const response = sent.value;
      if (response.status < 200 || response.status > 299) {
        // The body of an error can echo the request, so it is never read.
        response.cancel();
        throw statusFailure(response.status);
      }
      answer.answered = true;
      const bytes = await readCapped(response, clock, limit);
      const parsed = parseJson(decodeText(bytes));
      if (!parsed.ok) throw malformed("The embeddings endpoint's response is not JSON.", response.status);
      answer.tokens = tokensOf(parsed.value);
      return vectorsOf(parsed.value, texts.length, response.status);
    } finally {
      clock.dispose();
    }
  }

  return {
    key: options.key,
    async embed(texts, purpose, signal) {
      if (texts.length === 0) return [];
      const target = targetOf(options.url);
      const sender = (transport ??= createCloudTransport());
      const meter = await options.meter?.();
      const startedAt = Date.now();
      const answer: Answer = { answered: false, tokens: null };
      try {
        return await post(sender, target, texts, purpose, signal, answer);
      } finally {
        // A 2xx answer was spent even when its vectors are refused, so its
        // usage is reported. Only a refused or unanswered request is voided.
        if (answer.answered) {
          meter?.used({ texts, purpose, tokens: answer.tokens, durationMs: Date.now() - startedAt });
        } else {
          meter?.failed();
        }
      }
    },
  };
}

function targetOf(url: string): HttpTarget {
  try {
    const endpoint = parseEndpoint(url, "endpoint");
    return httpTarget(endpoint, "POST", endpoint.path);
  } catch {
    throw new SearchIndexError(
      "refused",
      "The embeddings url is not an https or http url with a host name. Fix [embeddings] url in workspace.toml, then publish again.",
    );
  }
}

async function readCapped(response: HttpTransportResponse, clock: Clock, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = response.body[Symbol.asyncIterator]();
  } catch (error) {
    response.cancel();
    throw sendFailure(error);
  }
  for (;;) {
    const next = await clock.race(iterator.next());
    if (next.kind === "stopped") {
      response.cancel();
      throw stopped(next.stop);
    }
    if (next.kind === "failed") {
      response.cancel();
      throw sendFailure(next.error);
    }
    if (next.value.done === true) return concat(chunks);
    total += next.value.value.byteLength;
    if (total > limit) {
      response.cancel();
      throw malformed(`The embeddings endpoint's response passed ${limit} bytes. Use a model with fewer dimensions.`, response.status);
    }
    chunks.push(next.value.value);
  }
}

/** One vector per text, ordered by index. Every check fails the whole response. */
function vectorsOf(value: unknown, count: number, status: number): Float32Array[] {
  const data = isRecord(value) ? value.data : undefined;
  if (!isList(data)) throw malformed("The embeddings endpoint's response has no data list.", status);
  if (data.length !== count) {
    throw malformed(`The embeddings endpoint returned ${data.length} vectors for ${count} entries.`, status);
  }
  const vectors = new Map<number, Float32Array>();
  let dimensions: number | undefined;
  for (const [position, item] of data.entries()) {
    const embedding = isRecord(item) ? item.embedding : undefined;
    if (!isRecord(item) || !isList(embedding)) {
      throw malformed("An item in the embeddings endpoint's data list has no embedding list.", status);
    }
    const index = item.index ?? position;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count || vectors.has(index)) {
      throw malformed("The embeddings endpoint's data list does not give each entry one index.", status);
    }
    if (embedding.length === 0 || embedding.length > MAX_DIMENSIONS) {
      throw malformed(`A vector from the embeddings endpoint has ${embedding.length} numbers. The limit is ${MAX_DIMENSIONS}.`, status);
    }
    dimensions ??= embedding.length;
    if (embedding.length !== dimensions) {
      throw malformed("The embeddings endpoint returned vectors of different lengths.", status);
    }
    const vector = new Float32Array(embedding.length);
    for (const [at, number] of embedding.entries()) {
      if (typeof number !== "number") throw malformed("A vector from the embeddings endpoint holds a value that is not a number.", status);
      vector[at] = number;
      if (!Number.isFinite(vector[at])) {
        throw malformed("A vector from the embeddings endpoint holds a number that is not finite.", status);
      }
    }
    vectors.set(index, vector);
  }
  const ordered: Float32Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const vector = vectors.get(index);
    // Unreachable: count distinct indexes below count cover every index.
    if (vector === undefined) throw malformed("The embeddings endpoint's data list skips an entry.", status);
    ordered.push(vector);
  }
  return ordered;
}

/** usage.total_tokens, which Voyage AI and OpenAI both send, or null when the response has no count. */
function tokensOf(value: unknown): number | null {
  const usage = isRecord(value) ? value.usage : undefined;
  const total = isRecord(usage) ? usage.total_tokens : undefined;
  return typeof total === "number" && Number.isInteger(total) && total >= 0 ? total : null;
}

function malformed(message: string, status: number): SearchIndexError {
  return new SearchIndexError("malformed", `${message} Search ranks by keyword until the endpoint answers with vectors.`, status);
}

function stopped(stop: Stop): SearchIndexError {
  return stop === "deadline"
    ? new SearchIndexError("timeout", "The embeddings endpoint did not answer in time. Search ranks by keyword until it does.")
    : new SearchIndexError("cancelled", "The embeddings request was cancelled before the endpoint answered.");
}

function statusFailure(status: number): SearchIndexError {
  if (status === 401 || status === 403) {
    return new SearchIndexError(
      "refused",
      `The embeddings endpoint refused the key with HTTP ${status}. Check the key [embeddings] credential names, then publish again.`,
      status,
    );
  }
  return new SearchIndexError(
    "unreachable",
    `The embeddings endpoint answered with HTTP ${status}. Search ranks by keyword until it answers with vectors.`,
    status,
  );
}

function sendFailure(error: unknown): SearchIndexError {
  if (error instanceof TransportError) {
    if (error.code === "timeout") return stopped("deadline");
    if (error.code === "refused_address" || error.code === "refused_redirect" || error.code === "refused_host") {
      return new SearchIndexError(
        "refused",
        "The embeddings url points at an address Oxagen does not send to, or redirects to another host. Use a public https endpoint.",
      );
    }
  }
  return new SearchIndexError("unreachable", "The embeddings request did not reach the endpoint. Search ranks by keyword until it does.");
}
