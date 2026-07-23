/**
 * Error- and edge-path coverage for the sidecar transport, independent of a
 * real `stella serve` binary. The happy path lives in sidecar-transport.test.ts;
 * this file exercises every failure branch (non-2xx responses, missing session
 * id, missing body, the 404-tolerant delete) plus the SSE parser's blank/non-
 * data line handling and the wire-type guards not touched by the happy path.
 */
import { describe, expect, test } from "vitest";
import { StellaSidecarClient } from "./sidecar-transport.js";
import {
  isCompleteEvent,
  isToolCallEvent,
  isToolResultEvent,
} from "./wire-types.js";

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

describe("StellaSidecarClient error paths", () => {
  test("constructor strips trailing slashes from baseUrl", async () => {
    let seen = "";
    const client = new StellaSidecarClient({
      baseUrl: "http://fake///",
      fetchImpl: stubFetch(({ url }) => {
        seen = url;
        return new Response(JSON.stringify({ session_id: "s" }), {
          status: 200,
        });
      }),
    });
    await client.createSession();
    expect(seen).toBe("http://fake/sessions");
  });

  test("createSession throws on a non-ok response", async () => {
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response("boom", { status: 500 })),
    });
    await expect(client.createSession()).rejects.toThrow(
      /createSession failed: 500 boom/,
    );
  });

  test("createSession throws when the body carries no session id", async () => {
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(
        () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
      ),
    });
    await expect(client.createSession()).rejects.toThrow(/missing session id/);
  });

  test("createSession accepts the camelCase sessionId field", async () => {
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(
        () =>
          new Response(JSON.stringify({ sessionId: "camel" }), { status: 200 }),
      ),
    });
    await expect(client.createSession()).resolves.toEqual({
      sessionId: "camel",
    });
  });

  test("openEventStream throws on a non-ok response", async () => {
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response(null, { status: 503 })),
    });
    await expect(client.openEventStream("s")).rejects.toThrow(
      /openEventStream failed: 503/,
    );
  });

  test("driveTurn throws on a non-ok response", async () => {
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response("nope", { status: 400 })),
    });
    await expect(client.driveTurn("s", "hi")).rejects.toThrow(
      /driveTurn failed: 400 nope/,
    );
  });

  test("deleteSession throws on a non-404 error but tolerates 404", async () => {
    const failing = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response(null, { status: 500 })),
    });
    await expect(failing.deleteSession("s")).rejects.toThrow(
      /deleteSession failed: 500/,
    );

    const missing = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response(null, { status: 404 })),
    });
    await expect(missing.deleteSession("s")).resolves.toBeUndefined();
  });

  test("event stream skips blank and non-data SSE lines", async () => {
    // A comment line, an event: line, and a blank data line, then two real
    // events — only the two JSON payloads should survive parsing.
    const raw =
      ": keep-alive\n" +
      "event: ping\n" +
      "data:\n\n" +
      `data: ${JSON.stringify({ seq: 0, type: "tool_result", call_id: "c", output: "x", is_error: false })}\n\n` +
      `data: ${JSON.stringify({ seq: 1, type: "complete", stop_reason: "end_turn" })}\n\n`;
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: stubFetch(() => new Response(streamOf(raw), { status: 200 })),
    });
    const stream = await client.openEventStream("s");
    const collected = [];
    for await (const event of stream) {
      collected.push(event);
      if (isCompleteEvent(event)) break;
    }
    expect(collected).toHaveLength(2);
    expect(collected.some(isToolResultEvent)).toBe(true);
    expect(collected.some(isToolCallEvent)).toBe(false);
  });
});
