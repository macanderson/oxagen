/**
 * A model call the proxy answers itself, without forwarding it, still seals
 * one frame on the session it was attributed to (ADR-256, #3824): a request
 * over the bytes the proxy holds (413), a harness that leaves while it
 * uploads, and a proxy that fails before it opens the call (502). The frame
 * is an `error` marked `oxagen.not_forwarded`, and a call that was forwarded
 * gets none.
 */
import {
  createServer,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import { TEST_ENROLLMENT, unsignedBundle } from "../host/test-support";
import type { PolicyBundle } from "../wire";
import type { SessionExclusive } from "./chain-write";
import {
  createModelProxy,
  type ModelProxy,
  type ModelProxyDeps,
} from "./model-proxy";
import type { ModelUpstreams } from "./model-routes";
import { SessionRegistry } from "./registry";

const SESSION_HEADER = "X-Claude-Code-Session-Id";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

/**
 * A session queue a test holds, the way a hook holds it between its seal and
 * its write. Work queued while it is held runs, in order, on `release`.
 */
function holdingQueue(): {
  exclusive: SessionExclusive;
  held: () => number;
  release: () => void;
} {
  const held: Array<() => void> = [];
  let holding = true;
  function exclusive<T>(
    _session: { readonly harnessSessionId: string },
    apply: () => T,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        try {
          resolve(apply());
        } catch (error) {
          reject(error);
        }
      };
      if (holding) held.push(run);
      else run();
    });
  }
  return {
    exclusive,
    held: () => held.length,
    release: () => {
      holding = false;
      for (const run of held.splice(0)) run();
    },
  };
}

/** POST a whole body to the proxy and read the answer. */
function call(
  port: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: Record<string, unknown> }> {
  return new Promise((resolve) => {
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/anthropic/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        ...headers,
      },
      agent: false,
    });
    req.on("response", (res) => {
      res.resume();
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers }),
      );
    });
    req.on("error", () => resolve({ status: 0, headers: {} }));
    req.end(body);
  });
}

describe("a call the proxy does not forward", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  /** A vendor that answers every call with a small message and counts them. */
  async function vendor() {
    let calls = 0;
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.resume();
      req.on("end", () => {
        calls += 1;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${calls}`,
            model: "claude-sonnet-5",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
    });
    const port = await listen(server);
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    );
    return { url: `http://127.0.0.1:${port}`, calls: () => calls };
  }

  async function proxyFor(
    upstreams: () => ModelUpstreams,
    deps: Partial<ModelProxyDeps> = {},
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
    const host = registry.ensure("tachod-not-forwarded", {
      harness: "claude-code",
    }).record;
    const events: TachoEvent[] = [];
    const log: string[] = [];
    const bundle = unsignedBundle() as PolicyBundle;
    let port = 0;
    const proxy: ModelProxy = createModelProxy({
      registry,
      hostRecorder: () => host.recorder,
      record: (sealed) => events.push(...sealed),
      policy: () => ({ bundle, hostStatus: "active" }),
      upstreams,
      port: () => port,
      log: (line) => log.push(line),
      now: Date.now,
      ...deps,
    });
    const server = createServer((req, res) => proxy.handle(req, res));
    port = await listen(server);
    cleanups.push(() => {
      proxy.close();
      return new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    });
    const session = (id: string) =>
      registry.ensure(id, { harness: "claude-code" }).record.recorder
        .sessionUuid;
    const frames = (uuid: string, kind: string) =>
      events.filter((e) => e.session_uuid === uuid && e.kind === kind);
    return { proxy, port, session, frames, log, events, host, registry };
  }

  const upstreamsAt = (url: string) => (): ModelUpstreams => ({
    anthropic: url,
    openai: `${url}/v1`,
    chatgpt: `${url}/backend-api/codex`,
  });

  it("seals an error frame for a request over the size the proxy holds, and answers 413", async () => {
    const fake = await vendor();
    const { port, session, frames } = await proxyFor(upstreamsAt(fake.url), {
      maxRequestBytes: 1024,
    });
    const uuid = session("sess-big");
    const answer = await call(
      port,
      { [SESSION_HEADER]: "sess-big" },
      JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096) }),
    );
    expect(answer.status).toBe(413);
    expect(fake.calls()).toBe(0);
    await until(() => frames(uuid, "error").length === 1);
    const frame = frames(uuid, "error")[0]!;
    expect(frame.fidelity).toBe("proxy");
    expect(frame.source).toBe("collector");
    expect(frame.body).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        api_status_code: 413,
        api_error_class: "request_too_large",
      }),
    );
    expect(frame.body).not.toHaveProperty("input_tokens");
    expect(frame.attrs["oxagen.not_forwarded"]).toBe("request_too_large");
    expect(frame.attrs["oxagen.correlation"]).toBe("harness_header");
    expect(Number(frame.attrs["oxagen.request_bytes_read"])).toBeGreaterThan(
      1024,
    );
    // The body never arrived whole, so nothing names it.
    expect(frame.attrs).not.toHaveProperty("oxagen.request_digest");
    expect(frames(uuid, "llm_call")).toHaveLength(0);
  });

  it("seals an error frame for a harness that leaves while it uploads", async () => {
    const fake = await vendor();
    const { port, session, frames, proxy } = await proxyFor(
      upstreamsAt(fake.url),
    );
    const uuid = session("sess-left");
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: "/anthropic/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": "100000",
        [SESSION_HEADER]: "sess-left",
      },
      agent: false,
    });
    req.on("error", () => {});
    req.write("x".repeat(1000));
    // Let the proxy take the request and read the first bytes, then leave.
    await new Promise((resolve) => setTimeout(resolve, 100));
    req.destroy();
    await until(() => frames(uuid, "error").length === 1);
    const frame = frames(uuid, "error")[0]!;
    expect(frame.body).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        api_error_class: "client_aborted",
      }),
    );
    // Nobody was answered: the harness had gone.
    expect(frame.body).not.toHaveProperty("api_status_code");
    expect(frame.attrs["oxagen.not_forwarded"]).toBe("client_aborted");
    const read = Number(frame.attrs["oxagen.request_bytes_read"]);
    expect(read).toBeGreaterThan(0);
    expect(read).toBeLessThanOrEqual(1000);
    expect(fake.calls()).toBe(0);
    expect(frames(uuid, "llm_call")).toHaveLength(0);
    expect(proxy.stats().inFlight).toBe(0);
  });

  it("seals an error frame when the proxy fails before it opens the call, and answers 502", async () => {
    // An upstream the proxy cannot parse makes it throw after it read and
    // attributed the request, and before it opened a connection.
    const { port, session, frames, log } = await proxyFor(() => ({
      anthropic: "not a url",
      openai: "not a url",
      chatgpt: "not a url",
    }));
    const uuid = session("sess-broken");
    const body = JSON.stringify({ model: "claude-sonnet-5" });
    const answer = await call(port, { [SESSION_HEADER]: "sess-broken" }, body);
    expect(answer.status).toBe(502);
    expect(answer.headers["x-oxagen-refusal"]).toBe("gateway_error");
    await until(() => frames(uuid, "error").length === 1);
    const frame = frames(uuid, "error")[0]!;
    expect(frame.body).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-sonnet-5",
        api_status_code: 502,
        api_error_class: "gateway_error",
      }),
    );
    expect(frame.attrs["oxagen.not_forwarded"]).toBe("gateway_error");
    expect(frame.attrs["oxagen.request_bytes_read"]).toBe(
      String(Buffer.byteLength(body)),
    );
    expect(frame.attrs["oxagen.request_digest"]).toMatch(/^sha256:/);
    // Attributed before it failed, so the frame carries the attrs a
    // forwarded call's frame would.
    expect(frame.attrs["oxagen.correlation"]).toBe("harness_header");
    expect(frame.attrs["oxagen.model_api"]).toBe("anthropic.messages");
    expect(frames(uuid, "llm_call")).toHaveLength(0);
    expect(log.some((line) => line.includes("failed"))).toBe(true);
  });

  it("seals no error frame for a call it forwarded", async () => {
    const fake = await vendor();
    const { port, session, frames, events } = await proxyFor(
      upstreamsAt(fake.url),
    );
    const uuid = session("sess-ok");
    const answer = await call(
      port,
      { [SESSION_HEADER]: "sess-ok" },
      JSON.stringify({ model: "claude-sonnet-5" }),
    );
    expect(answer.status).toBe(200);
    await until(() => frames(uuid, "llm_call").length === 1);
    expect(events.filter((e) => e.kind === "error")).toHaveLength(0);
  });
});

describe("frames of a call the proxy answers itself, on the session's queue", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function proxyWith(deps: Partial<ModelProxyDeps>) {
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
    const host = registry.ensure("tachod-session-queue", {
      harness: "claude-code",
    }).record;
    const events: TachoEvent[] = [];
    const log: string[] = [];
    const bundle = unsignedBundle() as PolicyBundle;
    let calls = 0;
    // A vendor no call here should reach.
    const vendor = createServer((req, res) => {
      calls += 1;
      req.resume();
      res.writeHead(500);
      res.end();
    });
    const vendorPort = await listen(vendor);
    const vendorUrl = `http://127.0.0.1:${vendorPort}`;
    let port = 0;
    const proxy = createModelProxy({
      registry,
      hostRecorder: () => host.recorder,
      record: (sealed) => events.push(...sealed),
      policy: () => ({ bundle, hostStatus: "active" }),
      upstreams: () => ({
        anthropic: vendorUrl,
        openai: `${vendorUrl}/v1`,
        chatgpt: `${vendorUrl}/backend-api/codex`,
      }),
      port: () => port,
      log: (line) => log.push(line),
      now: Date.now,
      ...deps,
    });
    const server = createServer((req, res) => proxy.handle(req, res));
    port = await listen(server);
    cleanups.push(() => {
      proxy.close();
      return Promise.all(
        [server, vendor].map(
          (open) =>
            new Promise<void>((resolve) => {
              open.closeAllConnections();
              open.close(() => resolve());
            }),
        ),
      ).then(() => undefined);
    });
    /** A session, and a frame a hook on its queue sealed and has not written. */
    const sessionWithHook = (id: string) => {
      const record = registry.ensure(id, { harness: "claude-code" }).record;
      const hookFrame = record.recorder.sealCollectorEvent(
        "oxagen:command_applied",
        { policy_decision: "allow", policy_source: "human" },
      );
      return { record, hookFrame };
    };
    return { port, events, log, sessionWithHook, calls: () => calls };
  }

  it("seals a refused call's frame after a hook there writes what it sealed", async () => {
    const queue = holdingQueue();
    const t = await proxyWith({ exclusive: queue.exclusive });
    const { record, hookFrame } = t.sessionWithHook("sess-refused");
    record.control.paused = "reviewing the run";
    const answer = call(
      t.port,
      { [SESSION_HEADER]: "sess-refused" },
      JSON.stringify({ model: "claude-sonnet-5" }),
    );
    // The refusal waits on the queue the hook holds.
    await until(() => queue.held() === 1);
    expect(t.events).toEqual([]);
    // The hook writes its frame and leaves the queue.
    t.events.push(hookFrame);
    queue.release();
    expect((await answer).status).toBe(403);
    // Sealed beside the hook, the refusal took the hook's seq + 1 and
    // reached the WAL first, and the hook's own write was refused.
    expect(t.events.map((event) => [event.kind, event.seq])).toEqual([
      ["oxagen:command_applied", hookFrame.seq],
      ["policy_decision", hookFrame.seq + 1],
    ]);
    expect(t.events[1]?.prev_hash).toBe(hookFrame.hash);
    expect(t.events[1]?.body).toMatchObject({
      policy_reason_code: "session_paused",
    });
    expect(t.calls()).toBe(0);
  });

  it("answers a refused call once the queue stays held past the wait, and seals its frame when the queue frees", async () => {
    const queue = holdingQueue();
    const t = await proxyWith({
      exclusive: queue.exclusive,
      refusalFrameWaitMs: 50,
    });
    const { record } = t.sessionWithHook("sess-held");
    record.control.paused = "reviewing the run";
    // A hook that runs long does not hold the model call with it.
    const answer = await call(
      t.port,
      { [SESSION_HEADER]: "sess-held" },
      JSON.stringify({ model: "claude-sonnet-5" }),
    );
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("session_paused");
    expect(queue.held()).toBe(1);
    expect(t.events).toEqual([]);
    expect(
      t.log.some((line) =>
        line.includes("answered a refused call before its frame could land"),
      ),
    ).toBe(true);
    queue.release();
    expect(t.events.map((event) => event.kind)).toEqual(["policy_decision"]);
    expect(t.events[0]?.session_uuid).toBe(record.recorder.sessionUuid);
    expect(t.calls()).toBe(0);
  });

  it("seals the frame of a call it did not forward after a hook there writes what it sealed", async () => {
    const queue = holdingQueue();
    const t = await proxyWith({
      exclusive: queue.exclusive,
      maxRequestBytes: 1024,
    });
    const { hookFrame } = t.sessionWithHook("sess-too-large");
    // The harness is answered while the hook holds the queue.
    const answer = await call(
      t.port,
      { [SESSION_HEADER]: "sess-too-large" },
      JSON.stringify({ model: "claude-sonnet-5", pad: "x".repeat(4096) }),
    );
    expect(answer.status).toBe(413);
    expect(queue.held()).toBe(1);
    expect(t.events).toEqual([]);
    t.events.push(hookFrame);
    queue.release();
    // Sealed beside the hook, the error frame took the hook's seq + 1 and
    // reached the WAL first, and the hook's own write was refused.
    expect(t.events.map((event) => [event.kind, event.seq])).toEqual([
      ["oxagen:command_applied", hookFrame.seq],
      ["error", hookFrame.seq + 1],
    ]);
    expect(t.events[1]?.attrs["oxagen.not_forwarded"]).toBe(
      "request_too_large",
    );
    expect(t.calls()).toBe(0);
  });
});
