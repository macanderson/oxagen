/**
 * Error- and edge-path coverage for the sidecar transport, independent of a
 * real `stella-serve` binary. The happy path lives in sidecar-transport.test.ts;
 * this file exercises every failure branch (non-2xx responses, a missing
 * turn id, a missing body, the 404-tolerant cancel) plus the SSE parser's
 * record-splitting and multi-line `data:` handling.
 */
import { describe, expect, test } from "vitest";

import { SidecarHttpError, StellaSidecarClient } from "./sidecar-transport";

type FetchArgs = { url: string; method: string };

/** A fetch stub returning a fixed Response for whatever route is hit. */
function stubFetch(handler: (args: FetchArgs) => Response): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    return handler({ url, method });
  }) as typeof fetch;
}

function streamOf(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

function clientWith(fetchImpl: typeof fetch): StellaSidecarClient {
  return new StellaSidecarClient({
    baseUrl: "http://fake",
    token: "tok",
    fetchImpl,
  });
}

describe("StellaSidecarClient error paths", () => {
  test("constructor strips trailing slashes from baseUrl", async () => {
    let seen = "";
    const client = new StellaSidecarClient({
      baseUrl: "http://fake///",
      token: "tok",
      fetchImpl: stubFetch(({ url }) => {
        seen = url;
        return new Response(JSON.stringify({ turn_id: "turn-1" }), {
          status: 200,
        });
      }),
    });
    await client.createTurn({ provider_id: "x", messages: [] });
    expect(seen).toBe("http://fake/v1/turns");
  });

  test("createTurn surfaces the status and body on a non-2xx", async () => {
    const client = clientWith(
      stubFetch(
        () => new Response("max_steps must be at least 1", { status: 400 }),
      ),
    );
    await expect(
      client.createTurn({ provider_id: "x", messages: [], max_steps: 0 }),
    ).rejects.toThrow(SidecarHttpError);
    // The status must survive on the error — a 429 (turn cap) is retryable
    // while a 400 (bad request) is not, and a caller cannot tell them apart
    // from a stringified message.
    await client
      .createTurn({ provider_id: "x", messages: [] })
      .catch((err: unknown) => {
        expect((err as SidecarHttpError).status).toBe(400);
        expect((err as SidecarHttpError).operation).toBe("createTurn");
      });
  });

  test("createTurn rejects a response with no turn_id", async () => {
    const client = clientWith(
      stubFetch(() => new Response(JSON.stringify({}), { status: 200 })),
    );
    await expect(
      client.createTurn({ provider_id: "x", messages: [] }),
    ).rejects.toThrow(/missing turn_id/);
  });

  test("openFrameStream distinguishes a bad status from an absent body", async () => {
    const conflict = clientWith(
      stubFetch(
        () =>
          new Response(
            JSON.stringify({
              error: "events are already being streamed for this turn",
            }),
            { status: 409 },
          ),
      ),
    );
    await expect(conflict.openFrameStream("turn-1")).rejects.toThrow(
      /409.*already being streamed/,
    );

    const bodyless = clientWith(
      stubFetch(() => new Response(null, { status: 200 })),
    );
    await expect(bodyless.openFrameStream("turn-1")).rejects.toThrow(
      /carried no body/,
    );
  });

  test("resolveProvider and resolveTool surface a 409 for a stale request id", async () => {
    const client = clientWith(
      stubFetch(
        () =>
          new Response(
            JSON.stringify({
              error: "no in-flight request with id `prov-0`",
            }),
            { status: 409 },
          ),
      ),
    );
    await expect(
      client.resolveProvider("turn-1", "prov-0", {
        usage: { input_tokens: 0, output_tokens: 0 },
        model: "m",
        cost_usd: 0,
      }),
    ).rejects.toThrow(/409.*no in-flight request/);
    await expect(
      client.resolveTool("turn-1", "tool-0", { ok: { content: "c" } }),
    ).rejects.toThrow(SidecarHttpError);
  });

  test("cancelTurn tolerates 404 but not other failures", async () => {
    const gone = clientWith(
      stubFetch(() => new Response(null, { status: 404 })),
    );
    await expect(gone.cancelTurn("turn-1")).resolves.toBeUndefined();

    const broken = clientWith(
      stubFetch(() => new Response("boom", { status: 500 })),
    );
    await expect(broken.cancelTurn("turn-1")).rejects.toThrow(SidecarHttpError);
  });

  test("health reports false on a bad status and on a thrown fetch", async () => {
    const down = clientWith(
      stubFetch(() => new Response(null, { status: 503 })),
    );
    expect(await down.health()).toBe(false);

    const refused = clientWith((() => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(await refused.health()).toBe(false);
  });

  test("the SSE parser skips comments and blank records, and joins multi-line data", async () => {
    // A single record whose `data:` field spans two lines must be concatenated
    // before parsing — splitting on every newline (the previous behaviour)
    // would throw a bare SyntaxError on the first half.
    const body =
      ": heartbeat comment\n\n" +
      "\n\n" +
      'data: {"type":"turn_complete","outcome":\ndata: {"status":"completed","text":"ok","cost_usd":1}}\n\n';
    const client = clientWith(
      stubFetch(() => new Response(streamOf(body), { status: 200 })),
    );
    const frames = [];
    for await (const frame of await client.openFrameStream("turn-1")) {
      frames.push(frame);
    }
    expect(frames).toEqual([
      {
        type: "turn_complete",
        outcome: { status: "completed", text: "ok", cost_usd: 1 },
      },
    ]);
  });

  test("a final record with no trailing blank line is still delivered", async () => {
    const client = clientWith(
      stubFetch(
        () =>
          new Response(
            streamOf(
              'data: {"type":"turn_complete","outcome":{"status":"aborted","reason":"x","cost_usd":0}}',
            ),
            { status: 200 },
          ),
      ),
    );
    const frames = [];
    for await (const frame of await client.openFrameStream("turn-1")) {
      frames.push(frame);
    }
    expect(frames).toHaveLength(1);
  });

  test("runTurn rethrows a handler failure instead of hanging on the turn", async () => {
    const client = clientWith(
      stubFetch(({ url }) => {
        if (url.endsWith("/v1/turns")) {
          return new Response(JSON.stringify({ turn_id: "turn-1" }), {
            status: 200,
          });
        }
        if (url.endsWith("/events")) {
          return new Response(
            streamOf(
              `data: ${JSON.stringify({
                type: "provider_request",
                request_id: "prov-0",
                request: { messages: [] },
              })}\n\n` +
                `data: ${JSON.stringify({
                  type: "turn_complete",
                  outcome: { status: "aborted", reason: "x", cost_usd: 0 },
                })}\n\n`,
            ),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }),
    );
    await expect(
      client.runTurn(
        { provider_id: "x", messages: [] },
        {
          onProviderRequest: async () => {
            throw new Error("the host's model adapter blew up");
          },
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      ),
    ).rejects.toThrow(/model adapter blew up/);
  });

  test("runTurn reports a stream that ends without a terminal frame", async () => {
    const client = clientWith(
      stubFetch(({ url }) => {
        if (url.endsWith("/v1/turns")) {
          return new Response(JSON.stringify({ turn_id: "turn-1" }), {
            status: 200,
          });
        }
        return new Response(
          streamOf('data: {"type":"event","event":{"type":"stage"}}\n\n'),
          { status: 200 },
        );
      }),
    );
    await expect(
      client.runTurn(
        { provider_id: "x", messages: [] },
        {
          onProviderRequest: async () => {
            throw new Error("unreachable");
          },
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      ),
    ).rejects.toThrow(/without a turn_complete frame/);
  });
});
