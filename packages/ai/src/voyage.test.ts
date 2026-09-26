import { describe, expect, it, vi } from "vitest";
import { APICallError } from "@ai-sdk/provider";
import {
  createVoyageEmbeddingModel,
  planVoyageRequests,
  VOYAGE_EMBEDDINGS_URL,
} from "./voyage";

const DIMS = 4;

function vector(seed: number): number[] {
  return Array.from({ length: DIMS }, (_, i) => seed + i / 10);
}

/** A fetch that answers each request with vectors in reverse index order. */
function okFetch(tokensPerText = 5) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { input: string[] };
    const data = body.input
      .map((_, index) => ({
        object: "embedding",
        embedding: vector(index),
        index,
      }))
      .reverse();
    return new Response(
      JSON.stringify({
        object: "list",
        data,
        model: "voyage-3-large",
        usage: { total_tokens: tokensPerText * body.input.length },
      }),
      { status: 200 },
    );
  });
}

function model(fetchImpl: typeof fetch, inputType?: "query" | "document") {
  return createVoyageEmbeddingModel({
    apiKey: "pa-test",
    modelId: "voyage-3-large",
    outputDimension: DIMS,
    inputType,
    fetch: fetchImpl,
  });
}

/** The error `doEmbed` rejects with. Fails the test when it resolves. */
async function embedError(
  fetchImpl: typeof fetch,
  values: string[],
): Promise<unknown> {
  try {
    await model(fetchImpl).doEmbed({ values });
  } catch (err) {
    return err;
  }
  throw new Error("expected doEmbed to reject");
}

describe("createVoyageEmbeddingModel", () => {
  it("posts the texts, model, input type, and dimension with the key as a bearer token", async () => {
    const fetchImpl = okFetch();
    await model(fetchImpl as unknown as typeof fetch, "document").doEmbed({
      values: ["a", "b"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(VOYAGE_EMBEDDINGS_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer pa-test",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      input: ["a", "b"],
      model: "voyage-3-large",
      input_type: "document",
      output_dimension: DIMS,
      truncation: true,
    });
  });

  it("leaves input_type out when none is given", async () => {
    const fetchImpl = okFetch();
    await model(fetchImpl as unknown as typeof fetch).doEmbed({
      values: ["a"],
    });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1].body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("input_type");
  });

  it("returns vectors in input order and reports total_tokens as usage.tokens", async () => {
    const result = await model(
      okFetch(5) as unknown as typeof fetch,
    ).doEmbed({ values: ["a", "b", "c"] });
    expect(result.embeddings).toEqual([vector(0), vector(1), vector(2)]);
    expect(result.usage).toEqual({ tokens: 15 });
  });

  it("reports no usage when Voyage omits it, so the meter warns instead of billing zero", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ embedding: vector(0), index: 0 }] }),
          { status: 200 },
        ),
    );
    const result = await model(fetchImpl as unknown as typeof fetch).doEmbed({
      values: ["a"],
    });
    expect(result.usage).toBeUndefined();
  });

  it("refuses a vector of the wrong length and does not retry it", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.1, 0.2], index: 0 }],
            usage: { total_tokens: 1 },
          }),
          { status: 200 },
        ),
    );
    const err = await embedError(fetchImpl as unknown as typeof fetch, [
      "a",
    ]);
    expect(APICallError.isInstance(err)).toBe(true);
    expect((err as APICallError).isRetryable).toBe(false);
    expect((err as APICallError).message).toContain(`${DIMS} numbers long`);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
    [403, false],
  ])("marks a %i answer retryable: %s", async (status, retryable) => {
    const fetchImpl = vi.fn(
      async () => new Response('{"detail":"no"}', { status }),
    );
    const err = (await embedError(
      fetchImpl as unknown as typeof fetch,
      ["a"],
    )) as APICallError;
    expect(APICallError.isInstance(err)).toBe(true);
    expect(err.statusCode).toBe(status);
    expect(err.isRetryable).toBe(retryable);
    expect(err.responseBody).toBe('{"detail":"no"}');
  });

  it("keeps customer text out of the error's request record", async () => {
    const fetchImpl = vi.fn(async () => new Response("bad", { status: 400 }));
    const err = (await embedError(fetchImpl as unknown as typeof fetch, [
      "secret customer text",
    ])) as APICallError;
    expect(JSON.stringify(err.requestBodyValues)).not.toContain(
      "secret customer text",
    );
  });

  it("treats a network failure as retryable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = (await embedError(
      fetchImpl as unknown as typeof fetch,
      ["a"],
    )) as APICallError;
    expect(APICallError.isInstance(err)).toBe(true);
    expect(err.isRetryable).toBe(true);
  });

  it("splits a batch over the token budget into several requests and sums their usage", async () => {
    const fetchImpl = okFetch(5);
    // Each text estimates at 32,000 tokens (the per-text cap), so three fit
    // under the 100,000-token budget and the fourth starts a new request.
    const long = "x".repeat(200_000);
    const result = await model(fetchImpl as unknown as typeof fetch).doEmbed({
      values: [long, long, long, long],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.embeddings).toHaveLength(4);
    expect(result.usage).toEqual({ tokens: 20 });
  });
});

describe("planVoyageRequests", () => {
  it("keeps a small batch in one request", () => {
    expect(planVoyageRequests(["a", "b", "c"])).toEqual([["a", "b", "c"]]);
  });

  it("starts a new request after 1,000 texts", () => {
    const values = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    const groups = planVoyageRequests(values);
    expect(groups.map((g) => g.length)).toEqual([1000, 1]);
  });

  it("starts a new request when the next text would pass the token budget", () => {
    // 6,000 characters estimate at 2,000 tokens, so 50 fill the 100,000 budget.
    const values = Array.from({ length: 60 }, () => "x".repeat(6_000));
    const groups = planVoyageRequests(values);
    expect(groups.map((g) => g.length)).toEqual([50, 10]);
  });

  it("counts a text longer than the context window at the window, since Voyage truncates it", () => {
    const huge = "x".repeat(1_000_000);
    expect(planVoyageRequests([huge, huge, huge])).toHaveLength(1);
  });

  it("returns no requests for no texts", () => {
    expect(planVoyageRequests([])).toEqual([]);
  });
});
