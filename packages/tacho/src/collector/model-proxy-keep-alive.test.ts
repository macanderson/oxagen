/**
 * The cache keep-alive end to end (lane F32): a real model proxy on an
 * ephemeral port, a session whose subagent opens and closes through its
 * hooks, and a fake vendor that keeps a prompt cache with a 5-minute TTL the
 * way Anthropic's does. A read restarts an entry's TTL, measured from the
 * request's start, and a request reads the longest cached prefix it shares.
 *
 * The clock is the test's. It drives the proxy, the vendor's TTL, and the
 * keep-alive check, which the test runs every 15 seconds of that clock with
 * `keepAliveTick`, as the proxy's own timer does in a daemon.
 */
import { createServer, type IncomingMessage, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import { TEST_ENROLLMENT, unsignedBundle } from "../host/test-support";
import {
  type PolicyBundle,
  TACHO_METERING_ATTR,
  TACHO_METERING_OBSERVED,
} from "../wire";
import {
  KEEP_ALIVE_ATTR,
  KEEP_ALIVE_COUNT_ATTR,
  KEEP_ALIVE_FINDING_ATTR,
  KEEP_ALIVE_TICK_MS,
  KEEP_ALIVE_TTL_ATTR,
} from "./cache-keep-alive";
import { createModelProxy } from "./model-proxy";
import type { ModelPrice } from "./model-pricing";
import { SessionRegistry } from "./registry";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-01T10:00:00.000Z");
const TTL = 5 * MINUTE;
const FINDING = "fnd_keepalive0000000000001";
const SESSION = "sess-keep-alive-parent";
const SUBAGENT = "agent-explore-1";

/** List prices in micro-USD per million tokens. */
const PRICE: ModelPrice = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  input: 3_000_000,
  output: 15_000_000,
  cache_read: 300_000,
  cache_write: 3_750_000,
  cache_write_1h: 6_000_000,
};

const PARENT_SYSTEM = [{ type: "text", text: "You are a coding agent." }];
const SUBAGENT_SYSTEM = [{ type: "text", text: "You search a repository." }];
const TOOLS = [{ name: "Read", input_schema: { type: "object" } }];

const text = (value: string, marked = false) => [
  {
    type: "text",
    text: value,
    ...(marked ? { cache_control: { type: "ephemeral" } } : {}),
  },
];

/** The parent's first request, and its next one after the wait. */
const PARENT_FIRST = {
  model: "claude-sonnet-5",
  max_tokens: 32_000,
  stream: true,
  thinking: { type: "adaptive" },
  system: PARENT_SYSTEM,
  tools: TOOLS,
  messages: [{ role: "user", content: text("Fix the build.", true) }],
};
const PARENT_NEXT = {
  ...PARENT_FIRST,
  messages: [
    { role: "user", content: text("Fix the build.") },
    { role: "assistant", content: text("I asked a subagent to search.") },
    { role: "user", content: text("Here is what it found.", true) },
  ],
};
const SUBAGENT_CALL = {
  ...PARENT_FIRST,
  system: SUBAGENT_SYSTEM,
  messages: [
    { role: "user", content: text("Find the failing test.") },
    { role: "assistant", content: text("Searching.") },
    { role: "user", content: text("Keep going.", true) },
  ],
};

/** What the fake vendor was asked. */
interface Asked {
  at: number;
  body: Record<string, unknown>;
  usage: { read: number; write: number };
}

function withoutMarkers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutMarkers);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (key !== "cache_control") out[key] = withoutMarkers(member);
  }
  return out;
}

/**
 * A vendor with a prompt cache. A request's prefix after k messages is
 * 20,000 + 40,000 × k tokens. Each request writes the entry at its last
 * message, reads the longest entry still cached, and restarts that entry's
 * TTL from its own start.
 */
async function fakeVendor(clock: () => number) {
  const cache = new Map<string, number>();
  const asked: Asked[] = [];
  const keyOf = (body: Record<string, unknown>, k: number) =>
    JSON.stringify(
      withoutMarkers([
        body["model"],
        body["system"],
        body["tools"],
        (body["messages"] as unknown[]).slice(0, k),
      ]),
    );
  const tokens = (k: number) => 20_000 + 40_000 * k;
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const at = clock();
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
        string,
        unknown
      >;
      const n = (body["messages"] as unknown[]).length;
      let read = 0;
      for (let k = n; k >= 1; k -= 1) {
        const key = keyOf(body, k);
        const expires = cache.get(key);
        if (expires !== undefined && expires > at) {
          read = tokens(k);
          cache.set(key, at + TTL);
          break;
        }
      }
      const write = tokens(n) - read;
      cache.set(keyOf(body, n), at + TTL);
      asked.push({ at, body, usage: { read, write } });
      const usage = {
        input_tokens: 10,
        cache_read_input_tokens: read,
        cache_creation_input_tokens: write,
        cache_creation: {
          ephemeral_5m_input_tokens: write,
          ephemeral_1h_input_tokens: 0,
        },
        output_tokens: body["max_tokens"] === 0 ? 0 : 5,
      };
      const id = `msg_${asked.length}`;
      if (body["stream"] === true) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id, type: "message", role: "assistant", model: body["model"], content: [], usage: { ...usage, output_tokens: 1 } } })}\n\n`,
        );
        res.write(
          `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        );
        res.end(`event: message_stop\ndata: {"type":"message_stop"}\n\n`);
        return;
      }
      const answer = JSON.stringify({
        id,
        type: "message",
        role: "assistant",
        model: body["model"],
        content: [],
        stop_reason: "max_tokens",
        usage,
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "request-id": `req_${asked.length}`,
      });
      res.end(answer);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    asked,
    keepAlives: () => asked.filter((a) => a.body["max_tokens"] === 0),
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const until = async (condition: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(condition()).toBe(true);
};

describe("the cache keep-alive through the model proxy", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function start(options: {
    keepAlive?: boolean;
    price?: ModelPrice;
  }) {
    let now = T0;
    const clock = () => now;
    const vendor = await fakeVendor(clock);
    cleanups.push(() => vendor.close());
    const registry = new SessionRegistry({
      scope: TEST_ENROLLMENT,
      now: clock,
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
    const host = registry.ensure("tachod-keep-alive", {
      harness: "claude-code",
    }).record;
    const parent = registry.ensure(SESSION, { harness: "claude-code" }).record;
    const events: TachoEvent[] = [];
    const log: string[] = [];
    const bundle = unsignedBundle({
      model_prices: [options.price ?? PRICE],
      ...(options.keepAlive === false
        ? {}
        : { cache_keep_alive: { finding_id: FINDING } }),
    }) as PolicyBundle;
    let port = 0;
    const proxy = createModelProxy({
      registry,
      hostRecorder: () => host.recorder,
      record: (sealed) => events.push(...sealed),
      policy: () => ({ bundle, hostStatus: "active" }),
      upstreams: () => ({
        anthropic: vendor.url,
        openai: `${vendor.url}/v1`,
        chatgpt: `${vendor.url}/backend-api/codex`,
      }),
      port: () => port,
      log: (line) => log.push(line),
      now: clock,
      // The test runs the check itself, on its own clock.
      keepAliveTickMs: 24 * 60 * MINUTE,
    });
    const server = createServer((req, res) => proxy.handle(req, res));
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

    const llmCalls = () => events.filter((e) => e.kind === "llm_call");
    /** One model call from the harness, settled and its frame sealed. */
    const call = async (atMs: number, body: object) => {
      now = T0 + atMs;
      const before = llmCalls().length;
      const payload = JSON.stringify(body);
      await new Promise<void>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/anthropic/v1/messages",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": String(Buffer.byteLength(payload)),
              "X-Api-Key": "sk-ant-api03-FAKE-keep-alive-test",
              "anthropic-version": "2023-06-01",
              "X-Claude-Code-Session-Id": SESSION,
            },
            agent: false,
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve());
          },
        );
        req.on("error", reject);
        req.end(payload);
      });
      await until(() => llmCalls().length === before + 1);
      return llmCalls().at(-1) as TachoEvent;
    };
    const hook = (atMs: number, name: "SubagentStart" | "SubagentStop") => {
      now = T0 + atMs;
      parent.recorder.ingestHook(
        {
          session_id: SESSION,
          hook_event_name: name,
          agent_id: SUBAGENT,
          agent_type: "Explore",
          ...(name === "SubagentStop"
            ? { last_assistant_message: "The failing test is in build.test.ts." }
            : {}),
        },
        {},
      );
    };
    /** Run the keep-alive check every 15 seconds from `fromMs` to `toMs`. */
    const wait = async (fromMs: number, toMs: number) => {
      for (let t = fromMs; t <= toMs; t += KEEP_ALIVE_TICK_MS) {
        now = T0 + t;
        await proxy.keepAliveTick();
      }
    };
    const keepAliveFrames = () =>
      llmCalls().filter((e) => e.attrs[KEEP_ALIVE_ATTR] === "1");
    return {
      vendor,
      parent,
      log,
      call,
      hook,
      wait,
      keepAliveFrames,
    };
  }

  /** The parent asks, hands work to a subagent, waits 12 minutes, and asks again. */
  async function twelveMinuteWait(h: Awaited<ReturnType<typeof start>>) {
    const first = await h.call(0, PARENT_FIRST);
    h.hook(10_000, "SubagentStart");
    expect(h.parent.recorder.openChildren.size).toBe(1);
    // The subagent's calls reach the proxy on its parent's session.
    await h.call(60_000, SUBAGENT_CALL);
    await h.wait(75_000, 11 * MINUTE + 30_000);
    h.hook(11 * MINUTE + 30_000, "SubagentStop");
    expect(h.parent.recorder.openChildren.size).toBe(0);
    await h.wait(11 * MINUTE + 45_000, 11 * MINUTE + 45_000);
    const next = await h.call(12 * MINUTE, PARENT_NEXT);
    return { first, next };
  }

  it("sends 2 keep-alives across a 12-minute wait on the 5-minute TTL, and the parent's next request reads the cache", async () => {
    const h = await start({});
    const { first, next } = await twelveMinuteWait(h);

    const sent = h.vendor.keepAlives();
    expect(sent.map((a) => a.at - T0)).toEqual([4.5 * MINUTE, 9 * MINUTE]);
    for (const keep of sent) {
      // The parent's own request, with no output asked for and no stream.
      expect(keep.body).toEqual({
        model: PARENT_FIRST.model,
        max_tokens: 0,
        thinking: PARENT_FIRST.thinking,
        system: PARENT_FIRST.system,
        tools: PARENT_FIRST.tools,
        messages: PARENT_FIRST.messages,
      });
      expect(keep.body).not.toHaveProperty("stream");
      expect(keep.usage).toEqual({ read: 60_000, write: 0 });
    }
    // The next request reads the prefix the keep-alives held, and writes
    // only what is new.
    expect(next.body).toMatchObject({
      cache_read_tokens: 60_000,
      cache_creation_tokens: 80_000,
    });
    expect(first.body).toMatchObject({ cache_creation_tokens: 60_000 });
  });

  it("records each keep-alive as an observed, priced model call on the parent's chain, so Spend counts it", async () => {
    const h = await start({});
    const { first } = await twelveMinuteWait(h);

    const frames = h.keepAliveFrames();
    expect(frames).toHaveLength(2);
    frames.forEach((frame, index) => {
      // The four marks ingest reads as an observed model call
      // (`isObservedModelCall` in packages/handlers/src/tacho.events.ingest.ts).
      expect(frame.kind).toBe("llm_call");
      expect(frame.source).toBe("collector");
      expect(frame.fidelity).toBe("proxy");
      expect(frame.attrs[TACHO_METERING_ATTR]).toBe(TACHO_METERING_OBSERVED);
      expect(frame.session_uuid).toBe(h.parent.recorder.sessionUuid);
      expect(frame.attrs[KEEP_ALIVE_FINDING_ATTR]).toBe(FINDING);
      expect(frame.attrs[KEEP_ALIVE_COUNT_ATTR]).toBe(String(index + 1));
      expect(frame.attrs[KEEP_ALIVE_TTL_ATTR]).toBe("5m");
      expect(frame.attrs["oxagen.correlation"]).toBe("cache_keep_alive");
      // 60,000 tokens read at $0.30 a million and 10 uncached at $3.
      expect(frame.body).toMatchObject({
        provider: "anthropic",
        model: "claude-sonnet-5",
        cache_read_tokens: 60_000,
        cache_creation_tokens: 0,
        output_tokens: 0,
        cost_usd_micros: 18_030,
        cost_basis: "observed",
        api_status_code: 200,
      });
      // The stored request names the parent's, and carries only what changed.
      expect(frame.attrs["oxagen.request_prior_digest"]).toBe(
        first.attrs["oxagen.request_full_digest"],
      );
      expect(Number(frame.attrs["oxagen.request_stored_bytes"])).toBeLessThan(
        Number(frame.attrs["oxagen.request_full_bytes"]),
      );
    });
  });

  it("sends no keep-alive when the bundle leaves it off, so the parent's next request writes its cache again (negative)", async () => {
    // The control plane leaves the field out when the agent's finding shows
    // no saving, and when the owning team turned the keep-alive off.
    const h = await start({ keepAlive: false });
    const { next } = await twelveMinuteWait(h);
    expect(h.vendor.keepAlives()).toEqual([]);
    expect(h.keepAliveFrames()).toEqual([]);
    expect(next.body).toMatchObject({
      cache_read_tokens: 0,
      cache_creation_tokens: 140_000,
    });
  });

  it("stops a wait once its keep-alives would cost more than one rewrite", async () => {
    // A read here costs 0.67 of the rewrite premium: one keep-alive fits,
    // and a second would cost more than the rewrite it saves.
    const h = await start({
      price: { ...PRICE, cache_read: 1_000_000, cache_write: 2_500_000 },
    });
    await twelveMinuteWait(h);
    expect(h.vendor.keepAlives().map((a) => a.at - T0)).toEqual([
      4.5 * MINUTE,
    ]);
    expect(h.log.join("\n")).toMatch(
      /2 keep-alives would cost at least one rewrite of the prefix/,
    );
  });

  it("sends nothing while the operator has the session paused (negative)", async () => {
    const h = await start({});
    await h.call(0, PARENT_FIRST);
    h.hook(10_000, "SubagentStart");
    h.parent.control.paused = "reviewing the run";
    await h.wait(15_000, 6 * MINUTE);
    expect(h.vendor.keepAlives()).toEqual([]);
    expect(h.log.join("\n")).toMatch(/session_paused/);
  });

  it("sends nothing while no subagent is open (negative)", async () => {
    const h = await start({});
    await h.call(0, PARENT_FIRST);
    await h.wait(15_000, 12 * MINUTE);
    expect(h.vendor.keepAlives()).toEqual([]);
  });
});
