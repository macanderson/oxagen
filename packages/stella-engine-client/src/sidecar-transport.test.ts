/**
 * Unit-level proof of the wire contract, independent of a real `stella
 * serve` binary: mocks fetch to speak the sidecar's HTTP+SSE surface and
 * drives the exact same client used by stella-serve.smoke.test.ts. This is
 * what lets CI (and this PR) demonstrate the "renaming an event field turns
 * the test red" property without needing a live binary — see the PR
 * description for the before/after run showing `call_id` -> `callId`
 * turning this file red.
 */
import { describe, expect, test } from "vitest";
import { StellaSidecarClient } from "./sidecar-transport.js";
import { isCompleteEvent, isToolCallEvent } from "./wire-types.js";

function sseBody(lines: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(line)}\n\n`));
      }
      controller.close();
    },
  });
}

function fakeFetch(events: object[]): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (url.endsWith("/sessions") && method === "POST") {
      return new Response(JSON.stringify({ session_id: "sess-123" }), {
        status: 200,
      });
    }
    if (url.includes("/events")) {
      return new Response(sseBody(events), { status: 200 });
    }
    if (url.includes("/turns") && method === "POST") {
      return new Response(null, { status: 202 });
    }
    if (method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

describe("StellaSidecarClient wire contract", () => {
  test("session open -> one turn -> event stream -> close, with concrete field assertions", async () => {
    const events = [
      {
        seq: 0,
        type: "tool_call",
        call_id: "call-1",
        name: "read_file",
        input: { path: "a.ts" },
      },
      {
        seq: 1,
        type: "tool_result",
        call_id: "call-1",
        output: "contents",
        is_error: false,
      },
      { seq: 2, type: "complete", stop_reason: "end_turn" },
    ];
    const client = new StellaSidecarClient({
      baseUrl: "http://fake",
      fetchImpl: fakeFetch(events),
    });

    const { sessionId } = await client.createSession();
    expect(sessionId).toBe("sess-123");

    const stream = await client.openEventStream(sessionId);
    await client.driveTurn(sessionId, "hello");

    const collected = [];
    for await (const event of stream) {
      collected.push(event);
      if (isCompleteEvent(event)) break;
    }

    const toolCall = collected.find(isToolCallEvent);
    expect(toolCall).toMatchObject({
      call_id: "call-1",
      name: "read_file",
      input: { path: "a.ts" },
    });
    expect(collected.filter(isCompleteEvent)).toHaveLength(1);

    await client.deleteSession(sessionId);
  });
});
