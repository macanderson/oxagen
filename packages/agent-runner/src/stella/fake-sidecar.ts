/**
 * A scripted `stella-serve` for tests: a `fetch` implementation that speaks the
 * real routes, so a test drives the REAL {@link StellaSidecarClient} rather
 * than a stub of it.
 *
 * Faking the client instead would test almost nothing — the SSE parsing, the
 * reverse-request dispatch, the concurrent-answer behaviour and the failure
 * reporting all live in the client, and they are the parts most likely to
 * break. Faking the transport keeps every one of them under test while staying
 * hermetic; the live round trip against a real binary is
 * `stella-serve.smoke.test.ts`'s job, and neither substitutes for the other.
 *
 * The script is a list of steps the fake plays in order. It emits a frame,
 * waits for the host to answer it, and only then moves on — which is what makes
 * an assertion about what the host sent on step 2 meaningful.
 */
import type { ServerFrame } from "@oxagen/stella-engine-client";

/** One scripted move by the engine. */
export type FakeStep =
  | { kind: "provider_request"; request?: Record<string, unknown> }
  | { kind: "tool_request"; name: string; input?: Record<string, unknown> }
  | { kind: "event"; event: Record<string, unknown> }
  | { kind: "complete"; text: string; costUsd?: number }
  | { kind: "abort"; reason: string; costUsd?: number };

export interface FakeSidecar {
  fetchImpl: typeof fetch;
  /** Every body the host POSTed back, in arrival order. */
  readonly posts: { route: string; body: Record<string, unknown> }[];
  /** The `POST /v1/turns` body the host opened the turn with. */
  readonly turnRequest: Record<string, unknown> | undefined;
}

/**
 * Build a fake sidecar that plays `script`.
 *
 * Reverse-request steps park until the matching `request_id` is answered, so
 * the fake exerts the same ordering contract a real engine does: the host must
 * actually POST a result for the turn to advance.
 */
export function createFakeSidecar(script: readonly FakeStep[]): FakeSidecar {
  const posts: { route: string; body: Record<string, unknown> }[] = [];
  const pending = new Map<string, () => void>();
  let turnRequest: Record<string, unknown> | undefined;

  const answered = (requestId: string): Promise<void> =>
    new Promise<void>((resolve) => pending.set(requestId, resolve));

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (frame: ServerFrame): void => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(frame)}\n\n`),
        );
      };

      for (const [index, step] of script.entries()) {
        const requestId = `req-${index}`;
        switch (step.kind) {
          case "event":
            send({ type: "event", event: step.event as never });
            break;
          case "provider_request": {
            const wait = answered(requestId);
            send({
              type: "provider_request",
              request_id: requestId,
              request: (step.request ?? { messages: [] }) as never,
            });
            await wait;
            break;
          }
          case "tool_request": {
            const wait = answered(requestId);
            send({
              type: "tool_request",
              request_id: requestId,
              name: step.name,
              input: step.input ?? {},
            });
            await wait;
            break;
          }
          case "complete":
            send({
              type: "turn_complete",
              outcome: {
                status: "completed",
                text: step.text,
                cost_usd: step.costUsd ?? 0,
              },
            });
            break;
          case "abort":
            send({
              type: "turn_complete",
              outcome: {
                status: "aborted",
                reason: step.reason,
                cost_usd: step.costUsd ?? 0,
              },
            });
            break;
        }
      }
      controller.close();
    },
  });

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const body = (init?.body ? JSON.parse(String(init.body)) : {}) as Record<
      string,
      unknown
    >;

    if (url.endsWith("/v1/turns")) {
      turnRequest = body;
      return json({ turn_id: "turn-1" });
    }
    if (url.endsWith("/events")) {
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }
    if (url.endsWith("/provider-result") || url.endsWith("/tool-result")) {
      const route = url.endsWith("/provider-result")
        ? "provider-result"
        : "tool-result";
      posts.push({ route, body });
      const requestId = String(body.request_id);
      const resolve = pending.get(requestId);
      pending.delete(requestId);
      resolve?.();
      return json({});
    }
    if (url.endsWith("/cancel")) return json({});
    if (url.endsWith("/healthz")) return json({});
    return new Response("not found", { status: 404 });
  };

  return {
    fetchImpl,
    posts,
    get turnRequest() {
      return turnRequest;
    },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
