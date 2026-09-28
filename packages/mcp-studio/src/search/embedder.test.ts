import { describe, expect, it, vi } from "vitest";
import { bodyJson, fakeHttp, header, reply, streamed } from "../execute/__tests__/fake-http";
import { TransportError, type HttpTransportRequest, type HttpTransportResponse } from "../execute/transport";
import { SearchIndexError, httpEmbedder, type HttpEmbedderOptions } from "./embedder";

const KEY = "sk-never-in-a-message";

function voyage(overrides: Partial<HttpEmbedderOptions> = {}): HttpEmbedderOptions {
  return {
    url: "https://api.voyageai.com/v1/embeddings",
    model: "voyage-4-large",
    key: "a".repeat(32),
    apiKey: KEY,
    inputType: true,
    ...overrides,
  };
}

function data(vectors: ReadonlyArray<readonly number[]>): unknown {
  return { object: "list", data: vectors.map((embedding, index) => ({ object: "embedding", index, embedding })) };
}

function only(requests: readonly HttpTransportRequest[]): HttpTransportRequest {
  const [request] = requests;
  if (request === undefined || requests.length !== 1) throw new Error("Expected one request.");
  return request;
}

async function failure(promise: Promise<unknown>): Promise<SearchIndexError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(SearchIndexError);
  const failed = error as SearchIndexError;
  expect(failed.name).toBe("SearchIndexError");
  expect(failed.message).not.toContain(KEY);
  expect(failed.message).not.toContain("voyageai.com");
  return failed;
}

describe("httpEmbedder", () => {
  it("posts the model, the input, and input_type with the key as a Bearer token", async () => {
    const http = fakeHttp(() => reply(200, data([[1, 0], [0, 1]])));
    const embedder = httpEmbedder(voyage({ transport: http.transport }));

    const vectors = await embedder.embed(["create_refund: Refund a charge.", "list_charges"], "document");

    expect(vectors).toEqual([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(embedder.key).toBe("a".repeat(32));
    const request = only(http.requests);
    expect(request.network).toBe("cloud");
    expect(request.relay_credential).toBeUndefined();
    expect(request.target).toEqual({
      kind: "http",
      scheme: "https",
      method: "POST",
      host: "api.voyageai.com",
      port: undefined,
      path: "/v1/embeddings",
    });
    expect(header(request, "authorization")).toBe(`Bearer ${KEY}`);
    expect(header(request, "content-type")).toBe("application/json");
    expect(bodyJson(request)).toEqual({
      model: "voyage-4-large",
      input: ["create_refund: Refund a charge.", "list_charges"],
      input_type: "document",
    });
  });

  it("sends no key and no input_type to a custom endpoint that takes neither", async () => {
    const http = fakeHttp(() => reply(200, data([[0.5, 0.5]])));
    const embedder = httpEmbedder(
      voyage({ url: "http://embed.example.com:8080/embed?v=2", apiKey: null, inputType: false, transport: http.transport }),
    );

    await embedder.embed(["refund"], "query");

    const request = only(http.requests);
    expect(header(request, "authorization")).toBeUndefined();
    expect(request.target).toMatchObject({ scheme: "http", host: "embed.example.com", port: 8080, path: "/embed?v=2" });
    expect(bodyJson(request)).toEqual({ model: "voyage-4-large", input: ["refund"] });
  });

  it("orders vectors by index, and reads a missing index as the item's place", async () => {
    const http = fakeHttp(() =>
      reply(200, {
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    );
    expect(await httpEmbedder(voyage({ transport: http.transport })).embed(["a", "b"], "document")).toEqual([
      new Float32Array([1]),
      new Float32Array([2]),
    ]);

    const positional = fakeHttp(() => reply(200, { data: [{ embedding: [3] }, { embedding: [4] }] }));
    expect(await httpEmbedder(voyage({ transport: positional.transport })).embed(["a", "b"], "document")).toEqual([
      new Float32Array([3]),
      new Float32Array([4]),
    ]);
  });

  it("sends nothing for no texts", async () => {
    const http = fakeHttp(() => reply(200, data([])));
    expect(await httpEmbedder(voyage({ transport: http.transport })).embed([], "document")).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it("refuses a url that does not parse before it sends", async () => {
    const http = fakeHttp(() => reply(200, data([[1]])));
    for (const url of ["not a url", "ftp://embed.example.com/", "https://user:pass@embed.example.com/"]) {
      const error = await failure(httpEmbedder(voyage({ url, transport: http.transport })).embed(["a"], "query"));
      expect(error.code).toBe("refused");
      expect(error.message).not.toContain("pass");
    }
    expect(http.requests).toHaveLength(0);
  });

  it("never reads the body of an error status", async () => {
    const read = vi.fn(() => reply(401, "invalid key sk-never-in-a-message").body[Symbol.asyncIterator]());
    const refused: HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> } = {
      status: 401,
      headers: [],
      body: { [Symbol.asyncIterator]: read },
      cancel: vi.fn(),
    };
    const http = fakeHttp(() => refused);

    const error = await failure(httpEmbedder(voyage({ transport: http.transport })).embed(["a"], "query"));

    expect(error.code).toBe("refused");
    expect(error.status).toBe(401);
    expect(error.message).not.toContain("invalid key");
    expect(refused.cancel).toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it("maps 403 to refused and other statuses to unreachable", async () => {
    const forbidden = await failure(httpEmbedder(voyage({ transport: fakeHttp(() => reply(403)).transport })).embed(["a"], "query"));
    expect(forbidden.code).toBe("refused");

    const limited = await failure(httpEmbedder(voyage({ transport: fakeHttp(() => reply(429, "slow down")).transport })).embed(["a"], "query"));
    expect(limited).toMatchObject({ code: "unreachable", status: 429 });
    expect(limited.message).toContain("HTTP 429");
    expect(limited.message).not.toContain("slow down");

    const redirect = await failure(httpEmbedder(voyage({ transport: fakeHttp(() => reply(302)).transport })).embed(["a"], "query"));
    expect(redirect.code).toBe("unreachable");
  });

  it("maps Transport failures to a code", async () => {
    const cases: Array<[unknown, string]> = [
      [new TransportError("timeout", "slow", true), "timeout"],
      [new TransportError("refused_address", "10.0.0.1 is private", false), "refused"],
      [new TransportError("refused_redirect", "moved", true), "refused"],
      [new TransportError("refused_host", "not allowed", false), "refused"],
      [new TransportError("not_sent", "ECONNREFUSED", false), "unreachable"],
      [new Error("socket hang up"), "unreachable"],
    ];
    for (const [thrown, code] of cases) {
      const http = fakeHttp(() => Promise.reject(thrown));
      const error = await failure(httpEmbedder(voyage({ transport: http.transport })).embed(["a"], "query"));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain("10.0.0.1");
    }
  });

  it("stops at the deadline", async () => {
    const http = fakeHttp(() => new Promise<HttpTransportResponse>(() => undefined));
    const error = await failure(httpEmbedder(voyage({ transport: http.transport, deadlineMs: 10 })).embed(["a"], "query"));
    expect(error.code).toBe("timeout");
    expect(only(http.requests).signal.aborted).toBe(true);
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    const http = fakeHttp(() => {
      controller.abort();
      return new Promise<HttpTransportResponse>(() => undefined);
    });
    const error = await failure(httpEmbedder(voyage({ transport: http.transport })).embed(["a"], "query", controller.signal));
    expect(error.code).toBe("cancelled");
  });

  it("stops a body that never ends at the deadline", async () => {
    const endless: HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> } = {
      status: 200,
      headers: [],
      body: {
        [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }),
      },
      cancel: vi.fn(),
    };
    const http = fakeHttp(() => endless);
    const error = await failure(httpEmbedder(voyage({ transport: http.transport, deadlineMs: 10 })).embed(["a"], "query"));
    expect(error.code).toBe("timeout");
    expect(endless.cancel).toHaveBeenCalled();
  });

  it("stops reading a body over the cap", async () => {
    const big = streamed(200, ['{"data":[', '{"embedding":[1]}]}'], []);
    const http = fakeHttp(() => big);
    const error = await failure(httpEmbedder(voyage({ transport: http.transport, maxResponseBytes: 12 })).embed(["a"], "query"));
    expect(error.code).toBe("malformed");
    expect(big.cancel).toHaveBeenCalled();
  });

  it("maps a body that fails as it arrives to unreachable", async () => {
    const broken = (next: () => Promise<IteratorResult<Uint8Array>>): HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> } => ({
      status: 200,
      headers: [],
      body: { [Symbol.asyncIterator]: () => ({ next }) },
      cancel: vi.fn(),
    });
    const midway = broken(() => Promise.reject(new Error("reset")));
    const error = await failure(httpEmbedder(voyage({ transport: fakeHttp(() => midway).transport })).embed(["a"], "query"));
    expect(error.code).toBe("unreachable");
    expect(midway.cancel).toHaveBeenCalled();

    const unopened: HttpTransportResponse & { cancel: ReturnType<typeof vi.fn> } = {
      status: 200,
      headers: [],
      body: {
        [Symbol.asyncIterator]: () => {
          throw new Error("closed");
        },
      },
      cancel: vi.fn(),
    };
    const closed = await failure(httpEmbedder(voyage({ transport: fakeHttp(() => unopened).transport })).embed(["a"], "query"));
    expect(closed.code).toBe("unreachable");
    expect(unopened.cancel).toHaveBeenCalled();
  });

  it("refuses a response that is not one vector per text", async () => {
    const bodies: unknown[] = [
      "not json",
      { vectors: [] },
      [],
      data([[1], [2], [3]]),
      { data: [{ index: 0 }, { index: 1, embedding: [1] }] },
      { data: ["x", "y"] },
      { data: [{ index: 0, embedding: [1] }, { index: 0, embedding: [2] }] },
      { data: [{ index: 2, embedding: [1] }, { index: 1, embedding: [2] }] },
      { data: [{ index: 0.5, embedding: [1] }, { index: 1, embedding: [2] }] },
      { data: [{ index: "0", embedding: [1] }, { index: 1, embedding: [2] }] },
      { data: [{ index: -1, embedding: [1] }, { index: 1, embedding: [2] }] },
      data([[], [1]]),
      data([new Array<number>(4097).fill(0), [1]]),
      data([[1, 2], [1]]),
      data([[1, "2"], [1, 2]]),
      data([[1, 1e39], [1, 2]]),
    ];
    for (const body of bodies) {
      const http = fakeHttp(() => reply(200, body));
      const error = await failure(httpEmbedder(voyage({ transport: http.transport })).embed(["a", "b"], "document"));
      expect(error.code).toBe("malformed");
      expect(error.status).toBe(200);
      expect(error.message).not.toContain("not json");
    }
  });
});
