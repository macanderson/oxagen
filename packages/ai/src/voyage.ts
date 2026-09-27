import {
  APICallError,
  type EmbeddingModelV4,
  type EmbeddingModelV4Result,
} from "@ai-sdk/provider";

/**
 * Voyage AI embeddings as an AI SDK embedding model.
 *
 * Oxagen embeds every text through Voyage with one platform key (Mac,
 * 2026-09-26, #4148). This is a small client written against the REST API
 * instead of a community provider, for three reasons:
 *
 *   - Voyage reports usage as `usage.total_tokens`. The meter needs that number
 *     as `usage.tokens`, and a shim that reads `prompt_tokens` would report no
 *     usage on every call.
 *   - Retrieval quality depends on `input_type`: `document` for text Oxagen
 *     stores, `query` for text it searches with.
 *   - A request is capped at 1,000 texts and, for voyage-4-large, 120,000
 *     tokens. The AI SDK splits by count through `maxEmbeddingsPerCall`; the
 *     token budget is split here, so one `embedMany` call stays one metered call.
 */

export const VOYAGE_EMBEDDINGS_URL = "https://api.voyageai.com/v1/embeddings";

/** How the text will be used. Voyage prepends a different prompt for each. */
export type VoyageInputType = "query" | "document";

/** Voyage's per-request text limit, for every embedding model. */
const MAX_TEXTS_PER_REQUEST = 1000;

/**
 * Token budget per request, below voyage-4-large's 120,000 so an estimate that
 * runs low still fits.
 */
const MAX_TOKENS_PER_REQUEST = 100_000;

/** voyage-4-large's context length. Voyage truncates longer inputs to it. */
const MAX_TOKENS_PER_TEXT = 32_000;

/**
 * Conservative token estimate. English runs near four characters a token; three
 * over-counts, so a batch splits early rather than being refused.
 */
function estimateTokens(text: string): number {
  return Math.min(Math.ceil(text.length / 3), MAX_TOKENS_PER_TEXT);
}

/** Split `values` into request-sized groups by count and token estimate. */
export function planVoyageRequests(values: string[]): string[][] {
  const groups: string[][] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const value of values) {
    const cost = estimateTokens(value);
    if (
      current.length > 0 &&
      (current.length >= MAX_TEXTS_PER_REQUEST ||
        tokens + cost > MAX_TOKENS_PER_REQUEST)
    ) {
      groups.push(current);
      current = [];
      tokens = 0;
    }
    current.push(value);
    tokens += cost;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

interface VoyageResponse {
  data?: { embedding?: unknown; index?: unknown }[];
  usage?: { total_tokens?: unknown };
}

/** 408, 409, 429, and 5xx are worth another attempt. Anything else is not. */
function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

export interface VoyageEmbeddingModelOptions {
  apiKey: string;
  modelId: string;
  /** The vector length every index expects. A response of any other length fails. */
  outputDimension: number;
  inputType?: VoyageInputType;
  /** Injected in tests. */
  fetch?: typeof fetch;
}

export function createVoyageEmbeddingModel(
  options: VoyageEmbeddingModelOptions,
): EmbeddingModelV4 {
  const doFetch = options.fetch ?? fetch;

  async function request(
    values: string[],
    abortSignal: AbortSignal | undefined,
  ): Promise<{ embeddings: number[][]; tokens: number | undefined }> {
    // The request body is recorded on errors without the texts: they are
    // customer content and do not belong in a log line.
    const requestBodyValues = {
      model: options.modelId,
      input_type: options.inputType ?? null,
      output_dimension: options.outputDimension,
      count: values.length,
    };

    let response: Response;
    try {
      response = await doFetch(VOYAGE_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          input: values,
          model: options.modelId,
          // Omitted rather than null when unset, which Voyage reads as "none".
          ...(options.inputType ? { input_type: options.inputType } : {}),
          output_dimension: options.outputDimension,
          truncation: true,
        }),
        signal: abortSignal,
      });
    } catch (cause) {
      throw new APICallError({
        message: `Voyage embeddings request did not complete: ${String(cause)}`,
        url: VOYAGE_EMBEDDINGS_URL,
        requestBodyValues,
        cause,
        isRetryable: true,
      });
    }

    const text = await response.text();
    if (!response.ok) {
      throw new APICallError({
        message: `Voyage embeddings returned ${response.status}: ${text.slice(0, 500)}`,
        url: VOYAGE_EMBEDDINGS_URL,
        requestBodyValues,
        statusCode: response.status,
        responseBody: text,
        isRetryable: isRetryableStatus(response.status),
      });
    }

    let body: VoyageResponse;
    try {
      body = JSON.parse(text) as VoyageResponse;
    } catch (cause) {
      throw new APICallError({
        message: "Voyage embeddings returned a body that is not JSON",
        url: VOYAGE_EMBEDDINGS_URL,
        requestBodyValues,
        statusCode: response.status,
        responseBody: text.slice(0, 500),
        cause,
        isRetryable: true,
      });
    }

    const data = body.data ?? [];
    if (data.length !== values.length) {
      throw new APICallError({
        message: `Voyage embeddings returned ${data.length} vectors for ${values.length} inputs`,
        url: VOYAGE_EMBEDDINGS_URL,
        requestBodyValues,
        statusCode: response.status,
        isRetryable: false,
      });
    }

    const embeddings = new Array<number[]>(values.length);
    for (const item of data) {
      const index = item.index;
      const vector = item.embedding;
      if (
        typeof index !== "number" ||
        !Array.isArray(vector) ||
        vector.length !== options.outputDimension
      ) {
        throw new APICallError({
          message: `Voyage embeddings returned a vector that is not ${options.outputDimension} numbers long`,
          url: VOYAGE_EMBEDDINGS_URL,
          requestBodyValues,
          statusCode: response.status,
          isRetryable: false,
        });
      }
      embeddings[index] = vector as number[];
    }

    const total = body.usage?.total_tokens;
    return {
      embeddings,
      tokens: typeof total === "number" ? total : undefined,
    };
  }

  return {
    specificationVersion: "v4",
    provider: "voyage",
    modelId: options.modelId,
    maxEmbeddingsPerCall: MAX_TEXTS_PER_REQUEST,
    supportsParallelCalls: false,
    async doEmbed({ values, abortSignal }): Promise<EmbeddingModelV4Result> {
      const embeddings: number[][] = [];
      let tokens = 0;
      let usageKnown = true;
      for (const group of planVoyageRequests(values)) {
        const result = await request(group, abortSignal);
        embeddings.push(...result.embeddings);
        if (result.tokens === undefined) usageKnown = false;
        else tokens += result.tokens;
      }
      return {
        embeddings,
        usage: usageKnown ? { tokens } : undefined,
        warnings: [],
      };
    },
  };
}
