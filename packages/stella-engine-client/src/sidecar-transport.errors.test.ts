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
    // before parsing — splitting on every newline would throw a bare
    // SyntaxError on the first half.
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

  // #1349: reverse requests are dispatched without being awaited, so a handler
  // can still be running when the terminal frame arrives. Its POST then lands
  // in a turn that has left the registry and answers 404 — and that used to be
  // rethrown, discarding the outcome already in hand one line above. Every
  // cancellation with a tool in flight took this path.
  const lateResultStream = (kind: "tool_request" | "provider_request") =>
    `data: ${JSON.stringify(
      kind === "tool_request"
        ? { type: "tool_request", request_id: "t-0", name: "read", input: {} }
        : {
            type: "provider_request",
            request_id: "p-0",
            request: { messages: [] },
          },
    )}\n\n` +
    `data: ${JSON.stringify({
      type: "turn_complete",
      outcome: { status: "aborted", reason: "cancelled", cost_usd: 0 },
    })}\n\n`;

  const lateResultClient = (
    kind: "tool_request" | "provider_request",
    status: number,
  ) =>
    clientWith(
      stubFetch(({ url }) => {
        if (url.endsWith("/v1/turns")) {
          return new Response(JSON.stringify({ turn_id: "turn-1" }), {
            status: 200,
          });
        }
        if (url.endsWith("/events")) {
          return new Response(streamOf(lateResultStream(kind)), {
            status: 200,
          });
        }
        // The turn is gone by the time the handler answers.
        return new Response("turn not found", { status });
      }),
    );

  test.each([
    ["tool_request", 404],
    ["tool_request", 409],
    ["provider_request", 404],
  ] as const)(
    "a %s result posted after the turn ended (%i) resolves with the outcome (#1349)",
    async (kind, status) => {
      const result = await lateResultClient(kind, status).runTurn(
        { provider_id: "x", messages: [] },
        {
          onProviderRequest: async () =>
            ({
              text: "ok",
              cost_usd: 0,
            }) as never,
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      );
      expect(result.outcome).toEqual({
        status: "aborted",
        reason: "cancelled",
        cost_usd: 0,
      });
    },
  );

  test("a 404 on a result route with NO terminal outcome still throws (#1349)", async () => {
    // The control that keeps the tolerance narrow. Without an outcome in hand a
    // 404 means a wrong turn id, not a race with the turn's end, and must stay
    // an error — otherwise this becomes a blanket swallow.
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
                type: "tool_request",
                request_id: "t-0",
                name: "read",
                input: {},
              })}\n\n`,
            ),
            { status: 200 },
          );
        }
        return new Response("turn not found", { status: 404 });
      }),
    );
    await expect(
      client.runTurn(
        { provider_id: "x", messages: [] },
        {
          onProviderRequest: async () => ({ text: "", cost_usd: 0 }) as never,
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      ),
    ).rejects.toThrow(SidecarHttpError);
  });

  /**
   * A fake engine that behaves like the real one: it does NOT emit
   * `turn_complete` until the client answers the reverse request it is parked
   * on. Both tests below need that, and it is what #1348 and #1279 say was
   * missing — the existing failure test answers `turn_complete` on the next
   * frame regardless, so it could never observe the engine being left waiting.
   */
  function parkedEngine() {
    const posts: Array<{ url: string; body: string }> = [];
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const encoder = new TextEncoder();

    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/turns")) {
        return new Response(JSON.stringify({ turn_id: "turn-1" }), {
          status: 200,
        });
      }
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "provider_request",
                    request_id: "p-0",
                    request: { messages: [] },
                  })}\n\n`,
                ),
              );
              // Parked: nothing more until the client says something.
              await answered;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "turn_complete",
                    outcome: { status: "aborted", reason: "x", cost_usd: 0 },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      posts.push({ url, body: String(init?.body ?? "") });
      release();
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch;

    return { client: clientWith(fetchImpl), posts };
  }

  test("a rejecting provider handler POSTs the error arm under report mode (#1348)", async () => {
    const { client, posts } = parkedEngine();
    const result = await client.runTurn(
      { provider_id: "x", messages: [] },
      {
        onFailure: "report",
        onProviderRequest: async () => {
          throw new Error("the host's model adapter blew up");
        },
        onToolRequest: async () => ({ ok: { content: "" } }),
      },
    );

    // The engine only completed because the client answered — so this asserts
    // the error actually reached it, not merely that runTurn returned.
    const posted = posts.find((x) => x.url.endsWith("/provider-result"));
    expect(posted).toBeDefined();
    const body = JSON.parse(posted!.body) as {
      status: string;
      error?: { kind?: string };
    };
    expect(body.status).toBe("error");
    expect(body.error?.kind).toBeTruthy();
    expect(result.outcome.status).toBe("aborted");
  });

  test("a rejecting handler cancels the parked turn instead of waiting it out (#1279)", async () => {
    const { client, posts } = parkedEngine();
    await expect(
      client.runTurn(
        { provider_id: "x", messages: [] },
        {
          // Default arm: no onFailure.
          onProviderRequest: async () => {
            throw new Error("the host's model adapter blew up");
          },
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      ),
    ).rejects.toThrow(/model adapter blew up/);

    // The engine was parked and would have waited out
    // reverse_request_timeout_ms. It completed because the client cancelled,
    // which is the only POST this arm makes — and the handler's own error is
    // still what surfaces, not a cancel failure.
    expect(posts.map((x) => x.url.split("/").pop())).toContain("cancel");
  });

  test("report mode cancels too when the report itself fails (#1279)", async () => {
    // Found by Sourcery on #2734's sibling. Under `report` a handler failure
    // that IS reported never reaches track()'s catch, so arriving there means
    // the report POST failed — the host can neither answer nor report, and the
    // engine would otherwise wait out its deadline exactly as in `throw`.
    const posts: string[] = [];
    let release!: () => void;
    const answered = new Promise<void>((r) => (release = r));
    const encoder = new TextEncoder();

    const client = clientWith((async (
      input: string | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.endsWith("/v1/turns")) {
        return new Response(JSON.stringify({ turn_id: "turn-1" }), {
          status: 200,
        });
      }
      if (url.endsWith("/events")) {
        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "provider_request",
                    request_id: "p-0",
                    request: { messages: [] },
                  })}\n\n`,
                ),
              );
              await answered;
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    type: "turn_complete",
                    outcome: { status: "aborted", reason: "x", cost_usd: 0 },
                  })}\n\n`,
                ),
              );
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      posts.push(url.split("/").pop() ?? "");
      if (url.endsWith("/provider-result")) {
        // The report cannot be delivered.
        return new Response("nope", { status: 500 });
      }
      release();
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as typeof fetch);

    await expect(
      client.runTurn(
        { provider_id: "x", messages: [] },
        {
          onFailure: "report",
          onProviderRequest: async () => {
            throw new Error("adapter blew up");
          },
          onToolRequest: async () => ({ ok: { content: "" } }),
        },
      ),
    ).rejects.toThrow(/provider-result failed: 500/);

    // It tried to report, then cancelled rather than leaving the engine parked.
    expect(posts).toContain("provider-result");
    expect(posts).toContain("cancel");
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
