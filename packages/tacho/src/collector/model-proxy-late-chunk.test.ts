/**
 * A response chunk that arrives after its call settled (#4107), and a call
 * still streaming when its session ends (C-04).
 *
 * A real socket cannot decide when its last chunk lands relative to
 * `settle`, so the upstream here is a fake: `node:http`'s `request` hands
 * the proxy a stand-in `ClientRequest` for one host, and the test emits the
 * vendor's response, and each chunk of it, exactly when it wants to.
 */
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TachoEvent } from "../envelope";
import { TEST_ENROLLMENT, unsignedBundle } from "../host/test-support";
import type { PolicyBundle } from "../wire";
import { createModelProxy, type ModelProxy } from "./model-proxy";
import { SessionRegistry } from "./registry";

const FAKE_HOST = "late-chunk-vendor.invalid";

/** The `ClientRequest` the proxy is handed for `FAKE_HOST`. */
class FakeUpstreamRequest extends EventEmitter {
  reusedSocket = false;
  destroyed = false;
  setTimeout(): this {
    return this;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    if (this.destroyed) return this;
    this.destroyed = true;
    // Node reports a destroyed request on a later tick, not inside the call.
    process.nextTick(() => this.emit("close"));
    return this;
  }
}

const upstreams = vi.hoisted(() => [] as FakeUpstreamRequest[]);
vi.mock("node:http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:http")>();
  return {
    ...actual,
    request: ((...args: Parameters<typeof actual.request>) => {
      const options = args[0];
      if (typeof options === "object" && "hostname" in options) {
        if (options.hostname === FAKE_HOST) {
          const fake = new FakeUpstreamRequest();
          upstreams.push(fake);
          return fake;
        }
      }
      return actual.request(...args);
    }) as typeof actual.request,
  };
});

/** The vendor's `IncomingMessage`: a stream the test writes chunks into. */
function vendorResponse(headers: Record<string, string>) {
  return Object.assign(new PassThrough(), {
    statusCode: 200,
    statusMessage: "OK",
    headers,
    rawHeaders: Object.entries(headers).flat(),
  });
}

const sse = (name: string, data: unknown) =>
  Buffer.from(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);

const EARLY = sse("message_start", {
  type: "message_start",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5",
    usage: { input_tokens: 1000, output_tokens: 1 },
  },
});
const LATE = sse("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "after the call settled" },
});

const sha = (bytes: Buffer) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe("a response chunk after its call settled", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    upstreams.length = 0;
  });

  async function start(
    headers: Record<string, string> = { "content-type": "text/event-stream" },
  ) {
    const registry = new SessionRegistry({
      scope: TEST_ENROLLMENT,
      now: Date.now,
      context: {
        agent: {
          agent_key: "acme.core.cc-laptop",
          fleet_id: "wrk_1",
          runtime: "claude-code",
          harness: "claude-code",
          wrapper_version: "2.1.1",
          host_enrollment_id: TEST_ENROLLMENT,
        },
      },
    });
    const host = registry.ensure("tachod-late-chunk", {
      harness: "claude-code",
    }).record;
    const session = registry.ensure("sess-late", {
      harness: "claude-code",
    }).record;
    const uuid = session.recorder.sessionUuid;
    const events: TachoEvent[] = [];
    const log: string[] = [];
    const bundle = unsignedBundle({}) as PolicyBundle;
    let port = 0;
    const proxy: ModelProxy = createModelProxy({
      registry,
      hostRecorder: () => host.recorder,
      record: (sealed) => events.push(...sealed),
      policy: () => ({ bundle, hostStatus: "active" }),
      upstreams: () => ({
        anthropic: `http://${FAKE_HOST}`,
        openai: `http://${FAKE_HOST}/v1`,
        chatgpt: `http://${FAKE_HOST}/backend-api/codex`,
      }),
      port: () => port,
      log: (line) => log.push(line),
      now: Date.now,
    });
    const server: Server = createServer((req, res) => proxy.handle(req, res));
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
    cleanups.push(() => {
      proxy.close();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    });

    // The caller's side: a streaming call that has read its headers.
    const call = async (
      body = JSON.stringify({ model: "claude-sonnet-5", stream: true }),
    ) => {
      const index = upstreams.length;
      const caller = request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/anthropic/v1/messages",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "X-Claude-Code-Session-Id": "sess-late",
        },
        agent: false,
      });
      caller.on("error", () => undefined);
      const answered = new Promise<void>((resolve) =>
        caller.on("response", (res) => {
          res.on("error", () => undefined);
          res.resume();
          resolve();
        }),
      );
      caller.end(body);

      await until(() => upstreams.length === index + 1);
      const upstreamReq = upstreams[index]!;
      const upstream = vendorResponse(headers);
      upstreamReq.emit("response", upstream);
      await answered;
      return { caller, upstreamReq, upstream };
    };
    const { caller, upstreamReq, upstream } = await call();

    const frames = () =>
      events.filter((e) => e.session_uuid === uuid && e.kind === "llm_call");
    const hostFrames = () =>
      events.filter(
        (e) =>
          e.session_uuid === host.recorder.sessionUuid && e.kind === "llm_call",
      );
    return {
      proxy,
      uuid,
      caller,
      upstream,
      upstreamReq,
      frames,
      hostFrames,
      log,
      registry,
      session,
      host,
      call,
    };
  }

  describe("when its session ends mid-stream", () => {
    it("is filed on the host's chain, not after the session's agent_stop", async () => {
      const { upstream, frames, hostFrames, registry, session } = await start();
      upstream.emit("data", EARLY);
      // SessionEnd seals the chain while the response is still streaming.
      registry.seal(session);
      upstream.end();
      await until(() => hostFrames().length === 1);
      expect(frames()).toEqual([]);
      const [frame] = hostFrames();
      expect(frame!.attrs["oxagen.correlation"]).toBe("session_closed");
      expect(frame!.body).toMatchObject({ input_tokens: 1000 });
      // The frame names the session it belongs to, and how the proxy
      // matched the call to it.
      expect(frame!.attrs["oxagen.session_uuid"]).toBe(
        session.recorder.sessionUuid,
      );
      expect(frame!.attrs["oxagen.session_correlation"]).toBe("harness_header");
    });

    it("counts the call once when the session's own record of it arrives later", async () => {
      const { upstream, hostFrames, registry, session } = await start();
      upstream.emit("data", EARLY);
      registry.seal(session);
      upstream.end();
      await until(() => hostFrames().length === 1);
      // The OTel exporter reports the same call on the session's chain.
      const late = session.recorder.sealCollectorEvent(
        "llm_call",
        { provider: "anthropic", message_id: "msg_1", input_tokens: 1000 },
        { source: "otel_log" },
      );
      expect(late.attrs["oxagen.llm_call_duplicate_of"]).toBe("collector");
    });

    it("stores the request whole, and the next call folds against nothing", async () => {
      const { upstream, frames, hostFrames, registry, session, call } =
        await start();
      upstream.emit("data", EARLY);
      upstream.end();
      await until(() => frames().length === 1);
      // A conversation long enough that the next call folds its prefix.
      const turn = (n: number) => ({
        role: "user",
        content: `message ${n} ${"x".repeat(2_000)}`,
      });
      const messages = (count: number) =>
        JSON.stringify({
          model: "claude-sonnet-5",
          stream: true,
          system: "s".repeat(2_000),
          messages: Array.from({ length: count }, (_, i) => turn(i)),
        });
      const settle = async (body: string, count: number) => {
        const next = await call(body);
        next.upstream.emit("data", EARLY);
        next.upstream.end();
        await until(() => frames().length === count);
      };
      await settle(messages(3), 2);
      // While the session is open, a call folds the prefix it shares with
      // the one before it.
      await settle(messages(4), 3);
      expect(frames()[2]!.attrs["oxagen.request_prior_digest"]).toBeDefined();

      const closing = await call(messages(5));
      closing.upstream.emit("data", EARLY);
      registry.seal(session);
      closing.upstream.end();
      await until(() => hostFrames().length === 1);
      const [filed] = hostFrames();
      expect(filed!.attrs["oxagen.request_prior_digest"]).toBeUndefined();
      expect(filed!.attrs["oxagen.request_stored_bytes"]).toBe(
        filed!.attrs["oxagen.request_full_bytes"],
      );

      // A resume, then a call whose prefix matches the one filed on the
      // host's chain: it must not point there.
      registry.ensure("sess-late", {
        harness: "claude-code",
        lastHookEvent: "SessionStart",
      });
      await settle(messages(6), 4);
      expect(frames()[3]!.attrs["oxagen.request_prior_digest"]).toBeUndefined();
    });

    it("is filed on the host's chain while the session's terminal waits for the WAL", async () => {
      const { upstream, frames, hostFrames, session } = await start();
      upstream.emit("data", EARLY);
      session.pendingTerminal = true;
      upstream.end();
      await until(() => hostFrames().length === 1);
      expect(frames()).toEqual([]);
    });
  });

  it("is ignored once the caller closed, and the frame digests only what came before", async () => {
    const { caller, upstream, upstreamReq, frames } = await start();

    upstream.emit("data", EARLY);
    caller.destroy();
    await until(() => frames().length === 1);
    expect(upstreamReq.destroyed).toBe(true);

    // The chunk the stream still had buffered, delivered after settle. On
    // main before #4107 this threw ERR_CRYPTO_HASH_FINALIZED out of the
    // listener, which in the daemon is an uncaught exception. `emit` rather
    // than `write`: once the caller is gone `pipe` unpipes and the stream may
    // pause, so a written chunk might never reach the listener and the test
    // would pass without exercising anything.
    expect(() => upstream.emit("data", LATE)).not.toThrow();

    const [frame] = frames();
    expect(frame!.body).toMatchObject({ api_error_class: "client_aborted" });
    expect(frame!.attrs["oxagen.response_digest"]).toBe(sha(EARLY));
    expect(frame!.attrs["oxagen.response_bytes"]).toBe(String(EARLY.length));
    expect(frames()).toHaveLength(1);
  });

  it("is ignored once the operator interrupted the call", async () => {
    const { proxy, uuid, upstream, frames } = await start();

    upstream.emit("data", EARLY);
    expect(proxy.abortSession(uuid, "operator stop")).toBe(1);
    await until(() => frames().length === 1);

    expect(() => upstream.emit("data", LATE)).not.toThrow();

    const [frame] = frames();
    expect(frame!.body).toMatchObject({ api_error_class: "interrupted" });
    expect(frame!.attrs["oxagen.response_digest"]).toBe(sha(EARLY));
    expect(frame!.attrs["oxagen.response_bytes"]).toBe(String(EARLY.length));
    expect(frames()).toHaveLength(1);
  });

  it("is ignored once the upstream failed mid-response", async () => {
    const { upstream, frames, log } = await start();

    upstream.emit("data", EARLY);
    upstream.emit("error", new Error("socket hang up"));
    expect(log.some((line) => line.includes("failed mid-response"))).toBe(true);
    expect(frames()).toHaveLength(1);

    expect(() => upstream.emit("data", LATE)).not.toThrow();

    const [frame] = frames();
    expect(frame!.body).toMatchObject({ api_error_class: "upstream_reset" });
    expect(frame!.attrs["oxagen.response_digest"]).toBe(sha(EARLY));
    expect(frame!.attrs["oxagen.response_bytes"]).toBe(String(EARLY.length));
    expect(frames()).toHaveLength(1);
  });

  it("is ignored for an encoded response too, and the digest covers the wire bytes", async () => {
    const early = gzipSync(EARLY);
    const { caller, upstream, frames } = await start({
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
    });

    upstream.emit("data", early);
    caller.destroy();
    await until(() => frames().length === 1);

    expect(() => upstream.emit("data", gzipSync(LATE))).not.toThrow();

    // Usage and body are not asserted: zlib decodes on a later tick, so
    // whether the decoded chunk reached the meter before settle is a race.
    const [frame] = frames();
    expect(frame!.attrs["oxagen.response_digest"]).toBe(sha(early));
    expect(frame!.attrs["oxagen.response_bytes"]).toBe(String(early.length));
    expect(frames()).toHaveLength(1);
  });
});
