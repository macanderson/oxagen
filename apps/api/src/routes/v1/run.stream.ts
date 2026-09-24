import { Hono } from "hono";
import { isHandlerError } from "@oxagen/oxagen";
import {
  CapabilityError,
  type CapabilityErrorCode,
  invoke,
} from "@oxagen/oxagen/kernel";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
import { logger } from "../../middleware/logger";

/**
 * How long one read waits inside the handler for a frame past the cursor
 * (`get_run.waitMs`, ARCHITECTURE.md §3.5). An idle stream therefore costs one
 * invoke per this interval, not one per client tick.
 */
const WAIT_MS = 20_000;
/**
 * How long a stream stays open with no frame before it closes and tells the
 * client to reconnect. A connection that lived forever would outlive the
 * platform's own request ceiling and be cut without a resume point.
 */
const IDLE_MS = 300_000;
/** Frames one read returns; the contract's page default. */
const FRAME_LIMIT = 200;

export const runStreamRoute = new Hono<AppEnv>();

/**
 * GET /:org_slug/:workspace_slug/runs/:run_id/stream — one run's frames, live.
 *
 * ## Why this is a loop over `get_run` and not a second transport
 *
 * This is the same SSE shape the in-app agent's stream uses (`chat.stream.ts`):
 * a `ReadableStream` of `data: <JSON>\n\n` lines, a terminal `event: done`, and
 * a typed `error` event once the stream is open. Nothing new is introduced —
 * no websocket, no long-lived database subscription, no second cursor format.
 *
 * What differs is the source. The chat stream wraps one turn that pushes parts
 * as it produces them; a run's frames arrive from a producer this process does
 * not host (ADR-043), so there is nothing to subscribe to. The read that
 * already knows how to wait for them is `get_run`'s handler-side long poll, and
 * this route is that poll turned into a stream: every iteration is one
 * `invoke("get_run")`, so the IAM check, the rules gate and the audit emission
 * happen on each read exactly as they do for a page load. A stream that
 * subscribed underneath the kernel would be a second path to the same frames
 * with none of those gates on it — access revoked mid-stream would keep
 * delivering.
 *
 * ## Resuming
 *
 * Each frame is written with its own `id:`, which is the opaque cursor
 * `get_run` minted for it. `EventSource` sends the last one back as
 * `Last-Event-ID` on reconnect, and the query parameter `after` does the same
 * for a client that is not `EventSource`. A read that starts at either repeats
 * nothing and skips nothing, so a dropped connection costs a round trip and no
 * frames.
 *
 * ## Closing
 *
 * `event: done` closes the stream. It carries a reason: `sealed` when the run
 * has ended and the last page had nothing behind it, and `idle` when the
 * stream reached IDLE_MS with nothing new — the client reconnects from the
 * cursor in that payload. Either way the client is never left guessing whether
 * more frames are coming.
 */
runStreamRoute.get("/", async (c) => {
  const runId = c.req.param("run_id");
  const after =
    c.req.header("last-event-id") ?? c.req.query("after") ?? undefined;
  const ctx = capabilityContext(c);

  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(ctl) {
      controller = ctl;
    },
    cancel() {
      closed = true;
    },
  });
  let closed = false;
  function write(chunk: string): void {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(chunk));
    } catch {
      // The client disconnected — the controller is closed. Latch it so the
      // loop stops on its next write rather than throwing per frame.
      closed = true;
    }
  }

  // The first read is awaited before the response is returned, so a refusal —
  // an unknown run, a revoked session, a run in another workspace — leaves
  // through the error middleware with the status the POST read answers,
  // instead of as a 200 whose first SSE line is an error nobody checks.
  const first = await invoke(
    runGet.name,
    runGet.input.parse({ runId, framesAfter: after, frameLimit: FRAME_LIMIT }),
    ctx,
    { surface: "api" },
  );

  void (async () => {
    let page = first as Awaited<ReturnType<typeof readRun>>;
    let cursor = after;
    let deadline = Date.now() + IDLE_MS;
    write(`event: run\ndata: ${JSON.stringify({ run: page.run })}\n\n`);
    try {
      for (;;) {
        for (const frame of page.frames.frames) {
          write(`id: ${frame.cursor}\ndata: ${JSON.stringify(frame)}\n\n`);
          if (!closed) cursor = frame.cursor;
        }
        if (closed) break;
        if (page.frames.frames.length > 0) deadline = Date.now() + IDLE_MS;
        // A sealed or halted run whose page had nothing behind it is done:
        // nothing will ever lie past it. A `live` run with a null cursor is
        // merely caught up — no frames yet, or a reconnect that landed
        // exactly on the head — and is not sealed; it keeps waiting below
        // rather than reporting a false `sealed` that closes a run still
        // going (finding 4, macanderson/oxagen#3370).
        if (page.frames.cursor === null && page.run.status !== "live") {
          write(
            `event: done\ndata: ${JSON.stringify({ reason: "sealed", cursor: cursor ?? null })}\n\n`,
          );
          break;
        }
        if (Date.now() >= deadline) {
          write(
            `event: done\ndata: ${JSON.stringify({ reason: "idle", cursor })}\n\n`,
          );
          break;
        }
        page = await readRun(ctx, runId, cursor);
      }
    } catch (err) {
      // The stream is open, so a failure is a typed event and not a status.
      // A refusal the person can act on travels with its code and message.
      // Anything else is a server fault: it is logged here, and the browser
      // gets `stream_unavailable` with a fixed message, never the kernel's
      // diagnostics (#3652).
      const code = streamErrorCode(err);
      if (code === undefined) {
        logger.error(
          { err, runId, requestId: ctx.requestId },
          "run stream failed",
        );
      }
      write(
        `event: error\ndata: ${JSON.stringify({
          message:
            code !== undefined && err instanceof Error
              ? err.message
              : "Run stream unavailable",
          code: code ?? "stream_unavailable",
          cursor: cursor ?? null,
        })}\n\n`,
      );
    }
    closed = true;
    try {
      controller.close();
    } catch {
      // Already closed by the client's disconnect.
    }
  })();

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      // Proxies that buffer an event stream turn a live feed into one long
      // pause followed by every frame at once.
      "x-accel-buffering": "no",
    },
  });
});

/**
 * The kernel codes that are a refusal the caller can act on, which are the
 * ones `middleware/error.ts` answers with a 4xx before the stream is open:
 * access (`authz_denied`, `surface_denied`, `pending_approval`), a capability
 * this surface does not have (`unknown_capability`, `no_handler`), and input
 * the contract refused (`invalid_input`, which is how `get_run` answers a
 * cursor it did not write). Every other code, `invalid_output` first among
 * them, is a server fault that middleware answers 500, so mid-stream it is
 * logged and sent as `stream_unavailable` rather than forwarded (#3652).
 *
 * Listed rather than derived because the middleware maps each code in its own
 * branch; `run.stream.test.ts` holds the two to the same answer.
 */
export const CLIENT_FACING_CAPABILITY_CODES: ReadonlySet<CapabilityErrorCode> =
  new Set<CapabilityErrorCode>([
    "authz_denied",
    "surface_denied",
    "pending_approval",
    "unknown_capability",
    "no_handler",
    "invalid_input",
  ]);

/**
 * The stable code a client shows for a failure mid-stream: a handler refusal's
 * reason, or a kernel refusal's code when it is one the caller can act on.
 * `get_run` answers a stale cursor with the latter (`invalid_input`), which is
 * the failure a resuming client is most likely to hit, so reading only the
 * former would leave exactly that case uncoded. Undefined means a server
 * fault, which the caller logs and does not describe.
 */
function streamErrorCode(err: unknown): string | undefined {
  if (isHandlerError(err)) return err.reason;
  return err instanceof CapabilityError &&
    CLIENT_FACING_CAPABILITY_CODES.has(err.code)
    ? err.code
    : undefined;
}

/** One read of the run, waiting inside the handler for a frame past the cursor. */
function readRun(
  ctx: ReturnType<typeof capabilityContext>,
  runId: string | undefined,
  after: string | undefined,
) {
  return invoke(
    runGet.name,
    runGet.input.parse({
      runId,
      framesAfter: after,
      frameLimit: FRAME_LIMIT,
      waitMs: WAIT_MS,
    }),
    ctx,
    { surface: "api" },
  ) as Promise<{
    run: { status: "live" | "sealed" | "halted" };
    frames: { frames: { cursor: string }[]; cursor: string | null };
  }>;
}
