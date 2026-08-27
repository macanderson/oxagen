/**
 * Unit-level proof of the wire contract, independent of a real `stella-serve`
 * binary: a stateful in-memory fake that speaks the sidecar's real HTTP+SSE
 * surface, driving the exact same client used by stella-serve.smoke.test.ts.
 * This is what lets CI demonstrate the "renaming a wire field turns the test
 * red" property in an environment with no Rust toolchain.
 *
 * The fake is stateful on purpose. A canned list of SSE frames cannot exercise
 * reverse RPC at all — the whole point of the protocol is that the engine's
 * *next* frame depends on the host's answer to its last request. The previous
 * revision of this file replayed a fixed three-frame fixture, which is why it
 * could assert a shape the real server never emits (`output: "contents"`,
 * `is_error: false`) and still pass: nothing in the loop was closed.
 *
 * Fidelity note: this fake mirrors the real server's *shapes*, and the smoke
 * test is what proves those shapes are right. Neither is sufficient alone —
 * a fake can only ever be as correct as the last time someone checked it
 * against the binary.
 */
import { describe, expect, test } from "vitest";

import { StellaSidecarClient } from "./sidecar-transport.js";
import {
  isTurnCompleteEvent,
  isEventFrame,
  isProviderRequestFrame,
  isTextEvent,
  isToolRequestFrame,
  isToolResultEvent,
  isToolStartEvent,
  isTurnCompleteFrame,
  type ServerFrame,
} from "./wire-types.js";

const TURN_ID = "turn-0123456789abcdef0123456789abcdef";

/**
 * A minimal stand-in for `stella-serve`: it raises a model call, then a tool
 * call once that is answered, then a second model call, then completes —
 * the same sequence the real engine produces for a one-tool turn.
 */
function fakeEngine(): typeof fetch {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  let providerAnswers = 0;

  const emit = (frame: ServerFrame): void => {
    controller?.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  };

  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;

    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url.endsWith("/v1/turns") && method === "POST") {
      return new Response(JSON.stringify({ turn_id: TURN_ID }), {
        status: 200,
      });
    }
    if (url.endsWith(`/v1/turns/${TURN_ID}/events`)) {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
          emit({ type: "event", event: { type: "stage", name: "execute" } });
          emit({
            type: "provider_request",
            request_id: "prov-0",
            request: {
              messages: [{ role: "user", content: "go" }],
              tools: [
                {
                  name: "echo",
                  description: "echo",
                  input_schema: { type: "object" },
                  read_only: false,
                },
              ],
            },
          });
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.endsWith(`/v1/turns/${TURN_ID}/provider-result`)) {
      // The flattened `status` must sit beside `request_id`, not nested.
      expect(body.status).toBe("ok");
      expect(body.request_id).toMatch(/^prov-\d+$/);
      providerAnswers += 1;
      if (providerAnswers === 1) {
        emit({
          type: "tool_request",
          request_id: "tool-0",
          name: "echo",
          input: { text: "hi" },
        });
      } else {
        emit({
          type: "turn_complete",
          outcome: { status: "completed", text: "done", cost_usd: 0.5 },
        });
        controller?.close();
      }
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url.endsWith(`/v1/turns/${TURN_ID}/tool-result`)) {
      expect(body.request_id).toBe("tool-0");
      // Externally tagged, single-key wrapper — not a `status` field.
      expect(Object.keys(body.output)).toEqual(["ok"]);
      emit({
        type: "event",
        event: {
          type: "tool_result",
          call_id: "c1",
          output: { ok: { content: "echoed" } },
          duration_ms: 3,
          speculated: false,
        },
      });
      emit({
        type: "provider_request",
        request_id: "prov-1",
        request: { messages: [{ role: "user", content: "go" }] },
      });
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    if (url.endsWith(`/v1/turns/${TURN_ID}/cancel`)) {
      return new Response(JSON.stringify({ status: "cancelled" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
    });
  }) as typeof fetch;
}

function client(): StellaSidecarClient {
  return new StellaSidecarClient({
    baseUrl: "http://fake",
    token: "test-token",
    fetchImpl: fakeEngine(),
  });
}

describe("StellaSidecarClient wire contract", () => {
  test("runTurn answers both reverse-RPC kinds and reaches a terminal outcome", async () => {
    const providerRequests: unknown[] = [];
    const toolRequests: { name: string; input: unknown }[] = [];

    const run = await client().runTurn(
      {
        provider_id: "oxagen-host",
        messages: [{ role: "user", content: "go" }],
      },
      {
        onProviderRequest: async (request) => {
          providerRequests.push(request);
          return {
            text: "",
            usage: { input_tokens: 1, output_tokens: 1 },
            model: "fake",
            cost_usd: 0.25,
          };
        },
        onToolRequest: async (name, input) => {
          toolRequests.push({ name, input });
          return { ok: { content: "echoed" } };
        },
      },
    );

    expect(run.turnId).toBe(TURN_ID);
    expect(run.providerCalls).toBe(2);
    expect(run.toolCalls).toBe(1);
    expect(toolRequests).toEqual([{ name: "echo", input: { text: "hi" } }]);
    expect(run.outcome).toEqual({
      status: "completed",
      text: "done",
      cost_usd: 0.5,
    });
    // Non-reverse `event` frames are collected, not answered.
    expect(run.events.map((e) => e.type)).toEqual(["stage", "tool_result"]);
    // The engine hands the tool schemas back on the model call.
    expect(
      (providerRequests[0] as { tools?: { name: string }[] }).tools?.[0]?.name,
    ).toBe("echo");
  });

  test("frame narrowing helpers discriminate on the `type` tag", () => {
    const provider: ServerFrame = {
      type: "provider_request",
      request_id: "prov-0",
      request: { messages: [] },
    };
    const tool: ServerFrame = {
      type: "tool_request",
      request_id: "tool-0",
      name: "echo",
      input: {},
    };
    const done: ServerFrame = {
      type: "turn_complete",
      outcome: { status: "aborted", reason: "cancelled", cost_usd: 0 },
    };

    expect(isProviderRequestFrame(provider)).toBe(true);
    expect(isProviderRequestFrame(tool)).toBe(false);
    expect(isToolRequestFrame(tool)).toBe(true);
    expect(isTurnCompleteFrame(done)).toBe(true);
    expect(isTurnCompleteFrame(provider)).toBe(false);
  });

  test("event narrowing helpers discriminate AgentEvents by tag", () => {
    // These are the tags oxagen branches on; the rest of the ~30-variant enum
    // flows through as an open envelope on purpose.
    expect(isEventFrame({ type: "event", event: { type: "text" } })).toBe(true);
    expect(isToolStartEvent({ type: "tool_start", call: {} })).toBe(true);
    expect(isToolStartEvent({ type: "tool_result" })).toBe(false);
    expect(isToolResultEvent({ type: "tool_result" })).toBe(true);
    expect(isTextEvent({ type: "text", delta: "hi" })).toBe(true);
    expect(isTextEvent({ type: "text_delta", text: "hi" })).toBe(false);
    expect(isTurnCompleteEvent({ type: "turn_complete", cost_usd: 1 })).toBe(
      true,
    );
    expect(isTurnCompleteEvent({ type: "stage" })).toBe(false);
    // The tag this guard used to carry. Stella emits no such AgentEvent, so a
    // guard matching it matched nothing on a live stream.
    expect(isTurnCompleteEvent({ type: "complete" })).toBe(false);
  });

  test("the bearer token is sent on every authenticated route", async () => {
    const seen: (string | null)[] = [];
    const spy = new StellaSidecarClient({
      baseUrl: "http://fake",
      token: "secret-token",
      fetchImpl: (async (input: string | URL, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seen.push(headers.get("authorization"));
        return new Response(JSON.stringify({ turn_id: TURN_ID }), {
          status: 200,
        });
      }) as typeof fetch,
    });

    await spy.createTurn({ provider_id: "x", messages: [] });
    await spy.resolveTool(TURN_ID, "tool-0", { ok: { content: "c" } });
    await spy.cancelTurn(TURN_ID);

    expect(seen).toEqual([
      "Bearer secret-token",
      "Bearer secret-token",
      "Bearer secret-token",
    ]);
  });
});
