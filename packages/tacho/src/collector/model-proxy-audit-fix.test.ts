/**
 * The loopback model proxy under the 2026-09-23 gateway audit: a proxy built
 * directly on a real session registry, a fake vendor behind it, and a client
 * that calls it the way the harnesses do.
 */
import {
  Agent as HttpAgent,
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
import {
  createModelProxy,
  type ForwardRequest,
  type ModelProxy,
  type ModelProxyDeps,
  retireIdleSockets,
} from "./model-proxy";
import { SessionRegistry } from "./registry";

const PRICES: NonNullable<PolicyBundle["model_prices"]> = [
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    input: 3_000_000,
    output: 15_000_000,
    cache_read: 300_000,
    cache_write: 3_750_000,
  },
  {
    provider: "anthropic",
    model: "claude-sonnet",
    input: 3_000_000,
    output: 15_000_000,
    cache_read: 300_000,
    cache_write: 3_750_000,
  },
  {
    provider: "openai",
    model: "gpt-5",
    input: 1_250_000,
    output: 10_000_000,
    cache_read: 125_000,
    cache_write: 1_250_000,
  },
];

const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

const MESSAGE_START = event("message_start", {
  type: "message_start",
  message: {
    id: "msg_1",
    model: "claude-sonnet-5",
    usage: { input_tokens: 1000, output_tokens: 1 },
  },
});
const TEXT = "t".repeat(400);
const TEXT_DELTA = event("content_block_delta", {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: TEXT },
});
const MESSAGE_END = `${event("message_delta", {
  type: "message_delta",
  delta: { stop_reason: "end_turn" },
  usage: { output_tokens: 20 },
})}${event("message_stop", { type: "message_stop" })}`;

const completed = (model = "gpt-5") =>
  event("response.completed", {
    type: "response.completed",
    response: {
      id: "resp_1",
      model,
      status: "completed",
      usage: { input_tokens: 100, output_tokens: 10 },
    },
  });

interface Answer {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  error?: string;
}

function call(
  port: number,
  options: { path?: string; headers?: Record<string, string>; body?: string },
): Promise<Answer> {
  return new Promise((resolve) => {
    const body = options.body ?? "{}";
    const req = request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: options.path ?? "/anthropic/v1/messages",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength(body)),
        ...options.headers,
      },
      agent: false,
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      const finish = (error?: string) =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          ...(error !== undefined ? { error } : {}),
        });
      res.on("end", () => finish());
      res.on("error", (error) => finish(error.message));
    });
    req.on("error", (error) =>
      resolve({ status: 0, headers: {}, body: "", error: error.message }),
    );
    req.end(body);
  });
}

/** One member of a frame's body, whatever kind of frame it is. */
const field = (frame: TachoEvent, name: string): unknown =>
  (frame.body as Record<string, unknown>)[name];

const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A port nothing listens on. */
async function deadPort(): Promise<number> {
  const server = createServer();
  const port = await listen(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("the model proxy after the gateway audit", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function vendor(
    handler: (req: IncomingMessage, res: ServerResponse, n: number) => void,
  ) {
    const requests: Array<{ url: string; body: string }> = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        requests.push({
          url: req.url ?? "",
          body: Buffer.concat(chunks).toString("utf8"),
        });
        handler(req, res, requests.length);
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
    return { url: `http://127.0.0.1:${port}`, port, requests };
  }

  async function proxyFor(
    upstream: () => string,
    options: {
      bundle?: Partial<Omit<PolicyBundle, "signature">>;
      deps?: Partial<ModelProxyDeps>;
      beforeForward?: (
        request: ForwardRequest,
        proxy: ModelProxy,
      ) => ForwardRequest | Promise<ForwardRequest>;
    } = {},
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
    const host = registry.ensure("tachod-audit", {
      harness: "claude-code",
    }).record;
    const events: TachoEvent[] = [];
    const log: string[] = [];
    const bundle = unsignedBundle({
      model_prices: PRICES,
      ...options.bundle,
    }) as PolicyBundle;
    let port = 0;
    const proxy: ModelProxy = createModelProxy({
      registry,
      hostRecorder: () => host.recorder,
      record: (sealed) => events.push(...sealed),
      policy: () => ({ bundle, hostStatus: "active" }),
      upstreams: () => ({
        anthropic: upstream(),
        openai: `${upstream()}/v1`,
        chatgpt: `${upstream()}/backend-api/codex`,
      }),
      port: () => port,
      log: (line) => log.push(line),
      now: Date.now,
      ...(options.beforeForward !== undefined
        ? {
            beforeForward: (request: ForwardRequest) =>
              options.beforeForward!(request, proxy),
          }
        : {}),
      ...options.deps,
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
    const session = (
      id: string,
      harness: "claude-code" | "codex" = "claude-code",
    ) => registry.ensure(id, { harness }).record.recorder.sessionUuid;
    const frames = (uuid: string, kind = "llm_call") =>
      events.filter((e) => e.session_uuid === uuid && e.kind === kind);
    return { proxy, port, registry, host, session, frames, log, events };
  }

  describe("a failure on the way to the vendor", () => {
    it("is answered 502 with x-should-retry true, and a refusal still says false", async () => {
      const dead = `http://127.0.0.1:${await deadPort()}`;
      const { port, registry, session, frames } = await proxyFor(() => dead);
      const uuid = session("sess-retry");
      const failed = await call(port, {
        headers: { "X-Claude-Code-Session-Id": "sess-retry" },
        body: JSON.stringify({ model: "claude-sonnet-5" }),
      });
      expect(failed.status).toBe(502);
      expect(failed.headers["x-oxagen-refusal"]).toBe("upstream_unreachable");
      expect(failed.headers["x-should-retry"]).toBe("true");
      expect(failed.headers["retry-after"]).toBe("1");
      expect(frames(uuid)[0]!.body).toMatchObject({
        api_error_class: "upstream_unreachable",
      });

      registry.get("sess-retry")!.control.paused = "lunch";
      const refused = await call(port, {
        headers: { "X-Claude-Code-Session-Id": "sess-retry" },
        body: JSON.stringify({ model: "claude-sonnet-5" }),
      });
      expect(refused.status).toBe(403);
      expect(refused.headers["x-should-retry"]).toBe("false");
      expect(refused.headers["retry-after"]).toBeUndefined();
    });

    it("sends a call again once, on a new connection, when the vendor reset the pooled one", async () => {
      const fake = await vendor((req, res, n) => {
        if (n === 2) {
          // The pooled connection the first call left behind, closed by the
          // vendor the moment the second call goes down it.
          req.socket.resetAndDestroy();
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `msg_${n}`,
            model: "claude-sonnet-5",
            usage: { input_tokens: 1, output_tokens: 1 },
          }),
        );
      });
      const { port, log } = await proxyFor(() => fake.url);
      const ask = () =>
        call(port, { body: JSON.stringify({ model: "claude-sonnet-5" }) });
      expect((await ask()).status).toBe(200);
      const second = await ask();
      expect(second.status).toBe(200);
      expect(JSON.parse(second.body)).toMatchObject({ id: "msg_3" });
      expect(fake.requests).toHaveLength(3);
      expect(
        log.filter((line) => line.includes("reset a pooled connection")),
      ).toHaveLength(1);
    });

    it("answers 504 when no connection to the vendor opens in time, and times nothing once one has", async () => {
      const fake = await vendor((_req, res) => {
        // Slower than the connect window, which a call that has its
        // connection no longer runs against.
        setTimeout(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"usage":{"input_tokens":1,"output_tokens":1}}');
        }, 150);
      });
      const { port, session, frames } = await proxyFor(() => fake.url, {
        deps: { upstreamConnectMs: 60 },
      });
      const uuid = session("sess-connect");
      const headers = { "X-Claude-Code-Session-Id": "sess-connect" };
      const body = JSON.stringify({ model: "claude-sonnet-5" });
      expect((await call(port, { headers, body })).status).toBe(200);

      // A pool with every socket taken: the request waits in the agent's
      // queue for a socket that never frees up.
      const prototype = HttpAgent.prototype as unknown as {
        addRequest: (req: unknown, options: { port?: unknown }) => void;
      };
      const addRequest = prototype.addRequest;
      prototype.addRequest = function held(this: unknown, req, options) {
        if (Number(options.port) === fake.port) return;
        addRequest.call(this, req, options);
      };
      try {
        const stalled = await call(port, { headers, body });
        expect(stalled.status).toBe(504);
        expect(stalled.headers["x-oxagen-refusal"]).toBe(
          "upstream_connect_timeout",
        );
        expect(stalled.headers["x-should-retry"]).toBe("true");
      } finally {
        prototype.addRequest = addRequest;
      }
      expect(frames(uuid).map((f) => field(f, "api_error_class"))).toEqual([
        undefined,
        "upstream_connect_timeout",
      ]);
      expect(fake.requests).toHaveLength(1);
    });

    it("closes a pooled connection once it has idled below the vendors' keep-alive", async () => {
      const server = createServer((_req, res) => res.end("ok"));
      const port = await listen(server);
      cleanups.push(
        () => new Promise<void>((resolve) => server.close(() => resolve())),
      );
      const agent = new HttpAgent({ keepAlive: true });
      retireIdleSockets(agent);
      cleanups.push(() => agent.destroy());
      await new Promise<void>((resolve) => {
        request({ host: "127.0.0.1", port, agent }, (res) => {
          res.resume();
          res.on("end", () => resolve());
        }).end();
      });
      await until(() => Object.values(agent.freeSockets).flat().length === 1);
      const [pooled] = Object.values(agent.freeSockets).flat();
      expect(pooled!.timeout).toBe(30_000);
    });
  });

  describe("which Codex session a call is filed under", () => {
    it("reads conversation_id, and prompt_cache_key only for a session it already knows", async () => {
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(completed());
      });
      const { port, registry, session, frames, host } = await proxyFor(
        () => fake.url,
      );
      const a = session("codex-a", "codex");
      const b = session("codex-b", "codex");
      const ask = (headers: Record<string, string>, extra = {}) =>
        call(port, {
          path: "/openai/v1/responses",
          headers: { Authorization: "Bearer sk-openai-FAKE", ...headers },
          body: JSON.stringify({ model: "gpt-5", stream: true, ...extra }),
        });

      await ask({ conversation_id: "codex-b" });
      await ask({}, { prompt_cache_key: "codex-a" });
      await ask({}, { prompt_cache_key: "not-a-session" });

      expect(frames(b)).toHaveLength(1);
      expect(frames(b)[0]!.attrs["oxagen.correlation"]).toBe("harness_header");
      expect(frames(a)).toHaveLength(1);
      expect(frames(a)[0]!.attrs["oxagen.correlation"]).toBe(
        "request_cache_key",
      );
      // A key naming nobody opens nothing: with two Codex sessions live the
      // call is filed on the host's own chain.
      expect(registry.get("not-a-session")).toBeUndefined();
      const orphan = frames(host.recorder.sessionUuid);
      expect(orphan).toHaveLength(1);
      expect(orphan[0]!.attrs["oxagen.correlation"]).toBe("unattributed");
    });
  });

  describe("the session budget under parallel calls", () => {
    it("holds an admitted call's ceiling, refuses a call beside it, and lets go when it settles or fails", async () => {
      let release: () => void = () => undefined;
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(MESSAGE_START);
        release = () => res.end(MESSAGE_END);
      });
      let upstream = fake.url;
      const { proxy, port, session, frames } = await proxyFor(() => upstream, {
        bundle: { budget: { mode: "enforced", session_limit_usd: 1 } },
      });
      const uuid = session("sess-parallel");
      const ask = (maxTokens: number) =>
        call(port, {
          headers: { "X-Claude-Code-Session-Id": "sess-parallel" },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: maxTokens,
            stream: true,
          }),
        });

      // 70,000 output tokens at $15 a million is $1.05: the whole limit.
      const first = ask(70_000);
      await until(() => fake.requests.length === 1);
      expect(proxy.stats().inFlight).toBe(1);
      const beside = await ask(10);
      expect(beside.status).toBe(403);
      expect(beside.headers["x-oxagen-refusal"]).toBe(
        "session_budget_exceeded",
      );
      expect(beside.body).toContain("held by calls in flight");
      expect(fake.requests).toHaveLength(1);

      release();
      expect((await first).status).toBe(200);
      await until(() => proxy.stats().inFlight === 0);
      // Settled at its real cost, a few cents, so the next call is admitted.
      expect(field(frames(uuid)[0]!, "cost_usd_micros")).toBe(3000 + 300);

      // A call that fails lets go of its ceiling too.
      upstream = `http://127.0.0.1:${await deadPort()}`;
      expect((await ask(70_000)).status).toBe(502);
      expect(proxy.stats().inFlight).toBe(0);
      upstream = fake.url;
      const after = ask(10);
      await until(() => fake.requests.length === 2);
      release();
      expect((await after).status).toBe(200);
    });
  });

  describe("the day budget under parallel calls", () => {
    it("holds an admitted call's ceiling against the agent's day, across sessions, and lets go when it settles", async () => {
      let release: () => void = () => undefined;
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(MESSAGE_START);
        release = () => res.end(MESSAGE_END);
      });
      // $0.90 of a $1 day is already settled, and no session limit is set.
      const { proxy, port, session } = await proxyFor(() => fake.url, {
        bundle: { budget: { mode: "enforced", daily_limit_usd: 1 } },
        deps: { priorDaySpendMicros: () => 900_000 },
      });
      session("sess-day-a");
      session("sess-day-b");
      const ask = (id: string, maxTokens: number) =>
        call(port, {
          headers: { "X-Claude-Code-Session-Id": id },
          body: JSON.stringify({
            model: "claude-sonnet-5",
            max_tokens: maxTokens,
            stream: true,
          }),
        });

      // 13,000 output tokens at $15 a million is $0.195. One call is admitted
      // on the $0.90 settled, and a second beside it would pass $1.
      const first = ask("sess-day-a", 13_000);
      await until(() => fake.requests.length === 1);
      const beside = await ask("sess-day-b", 13_000);
      expect(beside.status).toBe(403);
      expect(beside.headers["x-oxagen-refusal"]).toBe("daily_budget_exceeded");
      expect(beside.body).toContain("held by calls in flight");
      expect(fake.requests).toHaveLength(1);

      release();
      expect((await first).status).toBe(200);
      await until(() => proxy.stats().inFlight === 0);
      // Settled at its real cost, a few cents, so a small call is admitted.
      const after = ask("sess-day-b", 10);
      await until(() => fake.requests.length === 2);
      release();
      expect((await after).status).toBe(200);
    });
  });

  describe("a stream that ends badly", () => {
    it("records Anthropic's event: error after a 200 as the call's error", async () => {
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          `${MESSAGE_START}${event("error", {
            type: "error",
            error: { type: "overloaded_error", message: "Overloaded" },
          })}`,
        );
      });
      const { port, session, frames } = await proxyFor(() => fake.url);
      const uuid = session("sess-overload");
      await call(port, {
        headers: { "X-Claude-Code-Session-Id": "sess-overload" },
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
      await until(() => frames(uuid).length === 1);
      expect(frames(uuid)[0]!.body).toMatchObject({
        api_status_code: 200,
        api_error_class: "stream_overloaded_error",
        cost_basis: "observed",
      });
    });

    it("records response.failed with its status though its usage is null", async () => {
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(
          event("response.failed", {
            type: "response.failed",
            response: {
              id: "resp_f",
              model: "gpt-5",
              status: "failed",
              error: { code: "server_error", message: "boom" },
              usage: null,
            },
          }),
        );
      });
      const { port, session, frames } = await proxyFor(() => fake.url);
      const uuid = session("sess-failed", "codex");
      await call(port, {
        path: "/openai/v1/responses",
        headers: { "session-id": "sess-failed" },
        body: JSON.stringify({ model: "gpt-5", stream: true }),
      });
      await until(() => frames(uuid).length === 1);
      expect(frames(uuid)[0]!.body).toMatchObject({
        stop_reason: "failed",
        message_id: "resp_f",
        api_error_class: "stream_server_error",
      });
    });

    it("estimates what a cut Anthropic stream carried instead of billing one token", async () => {
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`${MESSAGE_START}${TEXT_DELTA}`);
        setTimeout(() => res.destroy(), 30);
      });
      const { port, session, frames } = await proxyFor(() => fake.url);
      const uuid = session("sess-cut");
      await call(port, {
        headers: { "X-Claude-Code-Session-Id": "sess-cut" },
        body: JSON.stringify({ model: "claude-sonnet-5", stream: true }),
      });
      await until(() => frames(uuid).length === 1);
      const [frame] = frames(uuid);
      expect(frame!.body).toMatchObject({
        api_error_class: "upstream_reset",
        input_tokens: 1000,
        output_tokens: 100,
        cost_usd_micros: 3000 + 1500,
        cost_basis: "estimated",
      });
      expect(frame!.attrs["oxagen.usage_partial"]).toBe("1");
    });

    it("estimates the input of a cut Responses stream from the request it sent", async () => {
      const fake = await vendor((_req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(
          event("response.output_text.delta", {
            type: "response.output_text.delta",
            delta: TEXT,
          }),
        );
        setTimeout(() => res.destroy(), 30);
      });
      const { port, session, frames } = await proxyFor(() => fake.url);
      const uuid = session("sess-cut-openai", "codex");
      const body = JSON.stringify({
        model: "gpt-5",
        stream: true,
        input: "i".repeat(3950),
      });
      await call(port, {
        path: "/openai/v1/responses",
        headers: { "session-id": "sess-cut-openai" },
        body,
      });
      await until(() => frames(uuid).length === 1);
      const [frame] = frames(uuid);
      expect(frame!.body).toMatchObject({
        input_tokens: Math.ceil(Buffer.byteLength(body) / 4),
        output_tokens: 100,
        cost_basis: "estimated",
      });
      expect(frame!.attrs["oxagen.usage_partial"]).toBe("1");
    });

    it("says a complete stream's count is observed, and a family row's price is estimated", async () => {
      const fake = await vendor((req, res) => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const model = req.headers["x-model"] as string;
        res.end(
          `${MESSAGE_START.replace("claude-sonnet-5", model)}${TEXT_DELTA}${MESSAGE_END}`,
        );
      });
      const { port, session, frames } = await proxyFor(() => fake.url);
      const uuid = session("sess-basis");
      for (const model of ["claude-sonnet-5", "claude-sonnet-9"])
        await call(port, {
          headers: {
            "X-Claude-Code-Session-Id": "sess-basis",
            "x-model": model,
          },
          body: JSON.stringify({ model, stream: true }),
        });
      await until(() => frames(uuid).length === 2);
      expect(frames(uuid).map((f) => field(f, "cost_basis"))).toEqual([
        "observed",
        "estimated",
      ]);
      expect(field(frames(uuid)[0]!, "output_tokens")).toBe(20);
      expect(frames(uuid)[0]!.attrs["oxagen.usage_partial"]).toBeUndefined();
    });
  });

  it("stops a call interrupted while beforeForward runs, before anything reaches the vendor", async () => {
    const fake = await vendor((_req, res) => res.end("{}"));
    const { proxy, port, session, frames } = await proxyFor(() => fake.url, {
      beforeForward: (request, self) => {
        self.abortSession(request.session!.sessionUuid, "operator pause");
        return request;
      },
    });
    const uuid = session("sess-early");
    const answer = await call(port, {
      headers: { "X-Claude-Code-Session-Id": "sess-early" },
      body: JSON.stringify({ model: "claude-sonnet-5" }),
    });
    expect(answer.status).toBe(403);
    expect(answer.headers["x-oxagen-refusal"]).toBe("interrupted_by_operator");
    expect(fake.requests).toHaveLength(0);
    expect(proxy.stats().inFlight).toBe(0);
    expect(frames(uuid)[0]!.body).toMatchObject({
      api_error_class: "interrupted",
    });
    expect(frames(uuid)[0]!.attrs["oxagen.interrupted"]).toBe("1");
  });
});
