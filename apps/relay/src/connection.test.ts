// connection.test.ts: the relay's connection to a fake broker over loopback.
//
// The fake broker is a plain ws server. Each test drives it frame by frame,
// so it can hold back the welcome, stay silent, break the protocol, or drop
// the connection, and then read what the relay did.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  CLOSE_TOKEN_REVOKED,
  decodeRelayFrame,
  encodeFrame,
  RELAY_PROTOCOL_VERSION,
  type BrokerFrame,
  type RelayFrame,
} from "@oxagen/relay-broker/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import type { RelayConfig } from "./config";
import {
  backoffDelay,
  MAX_CONCURRENT_CALLS,
  startRelay,
  type RelayHandle,
  type RelayState,
  type StartRelayOptions,
} from "./connection";
import type { RelayLog, RelayLogFields } from "./log";
import {
  GRPC_TARGET,
  HTTP_TARGET,
  RELAY,
  requestFrame,
  testConfig,
  testKey,
  unsignedEnvelope,
  WORKSPACE,
  type EnvelopeSpec,
  type TestKey,
} from "./test/fixtures";
import type { RelayGrpcTarget, RelayHttpTarget, UpstreamCall, Upstreams } from "./upstream/types";
import type { RequestFrame } from "./verify";

/** Items in arrival order, and a promise for the next one. */
class Queue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((item: T) => void)[] = [];

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.items.push(item);
    else waiter(item);
  }

  shift(): Promise<T> {
    if (this.items.length > 0) return Promise.resolve(this.items.shift() as T);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

interface Closed {
  code: number;
  reason: string;
}

/** The broker's end of one connection from the relay. */
class Peer {
  readonly frames = new Queue<RelayFrame>();
  readonly closed: Promise<Closed>;
  /** Answer each heartbeat with hb_ack. */
  ackHeartbeats = false;
  heartbeats = 0;

  constructor(
    readonly socket: WebSocket,
    readonly authorization: string | undefined,
  ) {
    this.closed = new Promise((resolve) => {
      socket.on("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
    });
    socket.on("message", (data: RawData) => {
      const frame = decodeRelayFrame(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
      if (frame === undefined) throw new Error("The relay sent a frame the fake broker cannot read.");
      if (frame.type === "hb") {
        this.heartbeats += 1;
        if (this.ackHeartbeats) this.send({ type: "hb_ack" });
      }
      this.frames.push(frame);
    });
  }

  /** The next frame the relay sent, skipping heartbeats unless asked. */
  async next(options: { heartbeats?: boolean } = {}): Promise<RelayFrame> {
    for (;;) {
      const frame = await this.frames.shift();
      if (frame.type !== "hb" || options.heartbeats === true) return frame;
    }
  }

  send(frame: BrokerFrame): void {
    this.socket.send(encodeFrame(frame));
  }

  welcome(heartbeatMs = 20_000): void {
    this.send({ type: "welcome", protocol: RELAY_PROTOCOL_VERSION, heartbeat_ms: heartbeatMs });
  }
}

class FakeBroker {
  readonly peers = new Queue<Peer>();
  upgrades = 0;
  /** Answer this many upgrades, and every one when Infinity, with 401. */
  refuse = 0;

  private constructor(
    private readonly server: Server,
    private readonly wss: WebSocketServer,
    readonly url: string,
  ) {
    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      this.upgrades += 1;
      if (this.refuse > 0) {
        this.refuse -= 1;
        socket.end("HTTP/1.1 401 Unauthorized\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        this.peers.push(new Peer(ws, request.headers.authorization));
      });
    });
  }

  static async start(): Promise<FakeBroker> {
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return new FakeBroker(server, wss, `ws://127.0.0.1:${port}/relay/v1/connect`);
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

interface LogEntry {
  event: string;
  fields: RelayLogFields;
}

function captureLog(): {
  log: RelayLog;
  entries: LogEntry[];
  named(event: string): LogEntry[];
  waitFor(event: string, count?: number): Promise<RelayLogFields>;
} {
  const entries: LogEntry[] = [];
  const waiters: { event: string; count: number; resolve: (fields: RelayLogFields) => void }[] = [];
  const named = (event: string): LogEntry[] => entries.filter((entry) => entry.event === event);
  const settle = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined) continue;
      const matches = named(waiter.event);
      const match = matches[waiter.count - 1];
      if (match !== undefined) {
        waiters.splice(index, 1);
        waiter.resolve(match.fields);
      }
    }
  };
  return {
    entries,
    named,
    log: (event, fields = {}) => {
      entries.push({ event, fields });
      settle();
    },
    waitFor: (event, count = 1) =>
      new Promise((resolve) => {
        waiters.push({ event, count, resolve });
        settle();
      }),
  };
}

type RecordedCall =
  | { kind: "http"; call: UpstreamCall<RelayHttpTarget> }
  | { kind: "grpc"; call: UpstreamCall<RelayGrpcTarget> };

function fakeUpstreams(): { upstreams: Upstreams; calls: RecordedCall[]; arrivals: Queue<RecordedCall>; closes: number } {
  const recorded = { calls: [] as RecordedCall[], arrivals: new Queue<RecordedCall>(), closes: 0 };
  const record = (entry: RecordedCall): void => {
    recorded.calls.push(entry);
    recorded.arrivals.push(entry);
  };
  const upstreams: Upstreams = {
    http: (call) => record({ kind: "http", call }),
    grpc: (call) => record({ kind: "grpc", call }),
    close: () => {
      recorded.closes += 1;
    },
  };
  return Object.assign(recorded, { upstreams });
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const handles: RelayHandle[] = [];
const brokers: FakeBroker[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.stop()));
  await Promise.all(brokers.splice(0).map((broker) => broker.close()));
});

interface Setup {
  broker: FakeBroker;
  key: TestKey;
  config: RelayConfig;
  logs: ReturnType<typeof captureLog>;
  upstream: ReturnType<typeof fakeUpstreams>;
  relay: RelayHandle;
  states: RelayState[];
}

async function setup(
  options: { relay?: Partial<StartRelayOptions>; config?: Partial<RelayConfig>; refuse?: number } = {},
): Promise<Setup> {
  const broker = await FakeBroker.start();
  brokers.push(broker);
  broker.refuse = options.refuse ?? 0;
  const key = testKey();
  const config = testConfig(key, { brokerUrl: broker.url, ...options.config });
  const logs = captureLog();
  const upstream = fakeUpstreams();
  const states: RelayState[] = [];
  const relay = startRelay({
    config,
    version: "test-1.0.0",
    log: logs.log,
    upstreams: upstream.upstreams,
    startDelayMs: 0,
    backoff: { initialMs: 20, maxMs: 100 },
    random: () => 0,
    onState: (state) => states.push(state),
    ...options.relay,
  });
  handles.push(relay);
  return { broker, key, config, logs, upstream, relay, states };
}

/** Accept the relay's next connection, read its hello, and welcome it. */
async function welcomed(broker: FakeBroker, heartbeatMs?: number): Promise<Peer> {
  const peer = await broker.peers.shift();
  const hello = await peer.next();
  expect(hello.type).toBe("hello");
  peer.welcome(heartbeatMs);
  return peer;
}

/** A request frame the relay accepts: issued now, for an allowed host. */
function freshRequest(key: TestKey, id: string, spec: EnvelopeSpec = {}): RequestFrame {
  return requestFrame(key, { issuedAt: Date.now(), ...spec }, id);
}

describe("backoffDelay", () => {
  const settings = { initialMs: 1_000, maxMs: 30_000 };

  it("doubles from the initial wait and keeps between half and all of it", () => {
    expect(backoffDelay(0, settings, () => 0)).toBe(500);
    expect(backoffDelay(0, settings, () => 0.5)).toBe(750);
    expect(backoffDelay(1, settings, () => 0)).toBe(1_000);
    expect(backoffDelay(2, settings, () => 0)).toBe(2_000);
  });

  it("stops at the ceiling, even for a very large attempt count", () => {
    expect(backoffDelay(5, settings, () => 0)).toBe(15_000);
    expect(backoffDelay(10_000, settings, () => 0.999_999)).toBe(30_000);
  });
});

describe("startRelay", () => {
  it("dials with the relay token, says hello, and turns ready at the welcome", async () => {
    const { broker, logs, relay, states } = await setup();
    const peer = await broker.peers.shift();
    expect(peer.authorization).toBe("Bearer rt_test_token");
    expect(await peer.next()).toEqual({
      type: "hello",
      protocol: RELAY_PROTOCOL_VERSION,
      relay: RELAY,
      workspace: WORKSPACE,
      version: "test-1.0.0",
    });
    expect(relay.state).toBe("connecting");
    peer.welcome();
    expect(await logs.waitFor("ready")).toEqual({ heartbeat_ms: 20_000 });
    expect(relay.state).toBe("ready");
    expect(states).toEqual(["connecting", "ready"]);
  });

  it("names itself in the first log line and clips a long version", async () => {
    const { broker, logs } = await setup({ relay: { version: "v".repeat(100) } });
    const peer = await broker.peers.shift();
    const hello = await peer.next();
    expect(hello.type === "hello" && hello.version.length).toBe(64);
    expect(logs.entries[0]?.event).toBe("starting");
    expect(logs.entries[0]?.fields).toMatchObject({ relay: RELAY, workspace: WORKSPACE, first_dial_in_ms: 0 });
  });

  it("waits twice the clock skew before the first dial by default", async () => {
    const { logs } = await setup({ relay: { startDelayMs: undefined }, config: { clockSkewMs: 50 } });
    expect(logs.entries[0]?.fields.first_dial_in_ms).toBe(100);
  });

  it("sends a heartbeat at the interval the welcome names", async () => {
    const { broker } = await setup();
    const peer = await welcomed(broker, 100);
    expect(await peer.next({ heartbeats: true })).toEqual({ type: "hb" });
  });

  it("stays connected while the broker answers heartbeats", async () => {
    const { broker, logs, relay } = await setup();
    const peer = await broker.peers.shift();
    peer.ackHeartbeats = true;
    await peer.next();
    peer.welcome(100);
    await sleep(550);
    expect(peer.heartbeats).toBeGreaterThanOrEqual(3);
    expect(logs.named("heartbeat_missed")).toEqual([]);
    expect(relay.state).toBe("ready");
  });

  it("drops the connection and reconnects when the broker goes silent for three heartbeats", async () => {
    const { broker, logs } = await setup();
    const peer = await welcomed(broker, 100);
    const missed = await logs.waitFor("heartbeat_missed");
    expect(missed.silent_ms).toBeGreaterThan(300);
    expect((await peer.closed).code).toBe(1006);
    await welcomed(broker);
    await logs.waitFor("ready", 2);
  });

  it("drops the connection when no welcome arrives in time", async () => {
    const { broker, logs } = await setup({ relay: { welcomeTimeoutMs: 150 } });
    const peer = await broker.peers.shift();
    await peer.next();
    expect(await logs.waitFor("welcome_timeout")).toEqual({ waited_ms: 150 });
    expect((await peer.closed).code).toBe(1006);
    expect(await logs.waitFor("reconnecting")).toEqual({ in_ms: 10, attempt: 1 });
  });

  it("backs off after each failed dial and resets the count after a welcome", async () => {
    const { broker, logs } = await setup({ refuse: 2 });
    const error = await logs.waitFor("connection_error");
    expect(String(error.message)).toContain("401");
    expect(String(error.message)).not.toContain("rt_test_token");
    expect(await logs.waitFor("reconnecting", 1)).toEqual({ in_ms: 10, attempt: 1 });
    expect(await logs.waitFor("reconnecting", 2)).toEqual({ in_ms: 20, attempt: 2 });

    const peer = await welcomed(broker);
    await logs.waitFor("ready");
    peer.socket.terminate();
    expect(await logs.waitFor("reconnecting", 3)).toEqual({ in_ms: 10, attempt: 1 });
    await welcomed(broker);
    await logs.waitFor("ready", 2);
    expect(broker.upgrades).toBe(4);
  });

  it.each([
    {
      name: "a frame before the welcome",
      breakIt: (peer: Peer) => peer.send({ type: "hb_ack" }),
      welcomeFirst: false,
    },
    {
      name: "text that is not a frame",
      breakIt: (peer: Peer) => peer.socket.send("not a frame"),
      welcomeFirst: false,
    },
    {
      name: "a binary frame",
      breakIt: (peer: Peer) =>
        peer.socket.send(Buffer.from(encodeFrame({ type: "welcome", protocol: 1, heartbeat_ms: 20_000 })), {
          binary: true,
        }),
      welcomeFirst: false,
    },
    {
      name: "a second welcome",
      breakIt: (peer: Peer) => peer.welcome(),
      welcomeFirst: true,
    },
  ])("closes with 1002 when the broker sends $name", async ({ breakIt, welcomeFirst }) => {
    const { broker, logs } = await setup();
    const peer = await broker.peers.shift();
    await peer.next();
    if (welcomeFirst) {
      peer.welcome();
      await logs.waitFor("ready");
    }
    breakIt(peer);
    expect((await peer.closed).code).toBe(1002);
    expect(logs.named("protocol_error")).toHaveLength(1);
    await logs.waitFor("reconnecting");
  });

  it("refuses an unsigned envelope and sends nothing upstream", async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send({ ...freshRequest(key, "call-1"), envelope: unsignedEnvelope({ issuedAt: Date.now() }) });
    expect(await peer.next()).toMatchObject({ type: "refused", id: "call-1", code: "unsigned" });
    expect(logs.named("refused")).toEqual([{ event: "refused", fields: { id: "call-1", code: "unsigned" } }]);
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a host the allowlist does not name", async () => {
    const { broker, key, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1", { target: { ...HTTP_TARGET, host: "payroll.internal" } }));
    const refused = await peer.next();
    expect(refused).toMatchObject({ type: "refused", id: "call-1", code: "host_not_allowed" });
    expect(upstream.calls).toEqual([]);
  });

  it("refuses a replayed envelope under a new call id", async () => {
    const { broker, key, upstream } = await setup();
    const peer = await welcomed(broker);
    const first = freshRequest(key, "call-1");
    peer.send(first);
    await upstream.arrivals.shift();
    peer.send({ ...first, id: "call-2" });
    expect(await peer.next()).toMatchObject({ type: "refused", id: "call-2", code: "replayed" });
    expect(upstream.calls).toHaveLength(1);
  });

  it("carries an accepted HTTP call upstream and its response back", async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1", { headers: [["accept", "application/json"]], body: "{}" }));
    const arrival = await upstream.arrivals.shift();
    if (arrival.kind !== "http") throw new Error("expected an HTTP call");
    expect(arrival.call.target).toEqual(HTTP_TARGET);
    expect(arrival.call.headers).toEqual([["accept", "application/json"]]);
    expect(Buffer.from(arrival.call.body).toString("utf8")).toBe("{}");
    expect(arrival.call.deadlineMs).toBe(30_000);
    // The log names the path and never its query string.
    expect(logs.named("call")[0]?.fields).toEqual({
      id: "call-1",
      kind: "http",
      host: "billing.internal",
      method: "POST",
      path: "/v1/invoices",
    });

    const { sink } = arrival.call;
    sink.head(200, [["content-type", "application/json"]]);
    expect(await sink.data(new TextEncoder().encode('{"ok":true}'))).toBe(true);
    sink.end();
    expect(await peer.next()).toEqual({ type: "head", id: "call-1", status: 200, headers: [["content-type", "application/json"]] });
    expect(await peer.next()).toEqual({ type: "data", id: "call-1", chunk: Buffer.from('{"ok":true}').toString("base64") });
    expect(await peer.next()).toEqual({ type: "end", id: "call-1" });
    expect(await logs.waitFor("call_done")).toMatchObject({ id: "call-1" });
    expect(arrival.call.signal.aborted).toBe(true);
  });

  it("carries an accepted gRPC call and its trailers", async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1", { target: GRPC_TARGET, deadlineMs: 5_000 }));
    const arrival = await upstream.arrivals.shift();
    if (arrival.kind !== "grpc") throw new Error("expected a gRPC call");
    expect(arrival.call.target).toEqual(GRPC_TARGET);
    expect(arrival.call.deadlineMs).toBe(5_000);
    expect(logs.named("call")[0]?.fields).toEqual({
      id: "call-1",
      kind: "grpc",
      host: "ledger.internal",
      service: "a_intel.ledger.v1.Ledger",
      method: "PostEntry",
    });
    arrival.call.sink.trailers(0, "", []);
    expect(await peer.next()).toEqual({ type: "head", id: "call-1", status: 200, headers: [] });
    expect(await peer.next()).toEqual({ type: "trailers", id: "call-1", code: 0, message: "", metadata: [] });
  });

  it("stops the upstream when the broker cancels the call", async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1"));
    const arrival = await upstream.arrivals.shift();
    peer.send({ type: "cancel", id: "call-1" });
    await aborted(arrival.call.signal);
    expect(arrival.call.sink.closed).toBe(true);
    await logs.waitFor("call_done");

    // The cancelled call sends nothing more: the next frame is the answer to a later request.
    arrival.call.sink.head(200, []);
    arrival.call.sink.end();
    peer.send({ ...freshRequest(key, "call-2"), envelope: {} });
    expect(await peer.next()).toMatchObject({ type: "refused", id: "call-2" });
  });

  it("ignores a cancel for a call it does not know", async () => {
    const { broker, key, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send({ type: "cancel", id: "nobody" });
    peer.send(freshRequest(key, "call-1"));
    expect((await upstream.arrivals.shift()).call.signal.aborted).toBe(false);
  });

  it("drops a request whose id is already in flight", async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "same"));
    await upstream.arrivals.shift();
    peer.send(freshRequest(key, "same"));
    expect(await logs.waitFor("duplicate_call")).toEqual({ id: "same" });
    peer.send({ ...freshRequest(key, "other"), envelope: {} });
    // No frame answers the duplicate: the first frame back answers "other".
    expect(await peer.next()).toMatchObject({ type: "refused", id: "other" });
    expect(upstream.calls).toHaveLength(1);
  });

  it(`refuses as busy past ${MAX_CONCURRENT_CALLS} calls at once`, async () => {
    const { broker, key, logs, upstream } = await setup();
    const peer = await welcomed(broker);
    for (let index = 0; index < MAX_CONCURRENT_CALLS; index += 1) peer.send(freshRequest(key, `call-${index}`));
    await logs.waitFor("call", MAX_CONCURRENT_CALLS);
    peer.send(freshRequest(key, "one-more"));
    expect(await peer.next()).toMatchObject({ type: "refused", id: "one-more", code: "busy" });
    expect(upstream.calls).toHaveLength(MAX_CONCURRENT_CALLS);
  });

  it("answers an upstream that throws with a fail the broker can read", async () => {
    const { broker, key } = await setup({
      relay: {
        upstreams: {
          http: () => {
            throw new Error("socket table full");
          },
          grpc: () => undefined,
          close: () => undefined,
        },
      },
    });
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1"));
    expect(await peer.next()).toEqual({
      type: "fail",
      id: "call-1",
      code: "upstream",
      message: "The relay could not start the call: socket table full",
      sent: false,
    });
  });

  it("fails closed: a lost connection stops every call and carries nothing until the next welcome", async () => {
    const { broker, key, logs, relay, upstream } = await setup();
    const peer = await welcomed(broker);
    peer.send(freshRequest(key, "call-1"));
    peer.send(freshRequest(key, "call-2", { target: GRPC_TARGET }));
    const first = await upstream.arrivals.shift();
    const second = await upstream.arrivals.shift();

    peer.socket.terminate();
    await Promise.all([aborted(first.call.signal), aborted(second.call.signal)]);
    expect(first.call.sink.closed).toBe(true);
    expect(second.call.sink.closed).toBe(true);
    expect(await logs.waitFor("disconnected")).toMatchObject({ calls_stopped: 2 });
    await logs.waitFor("reconnecting");
    expect(["waiting", "connecting"]).toContain(relay.state);

    // The next connection has no welcome yet, so a request on it is a protocol error.
    const next = await broker.peers.shift();
    await next.next();
    next.send(freshRequest(key, "call-3"));
    expect((await next.closed).code).toBe(1002);
    expect(upstream.calls).toHaveLength(2);
  });

  it("logs a revoked token when the broker closes with 4001, and keeps dialing", async () => {
    const { broker, logs } = await setup();
    const peer = await welcomed(broker);
    peer.socket.close(CLOSE_TOKEN_REVOKED, "relay token revoked");
    expect(await logs.waitFor("disconnected")).toMatchObject({ code: CLOSE_TOKEN_REVOKED });
    expect(await logs.waitFor("token_revoked")).toStrictEqual({
      message: "Oxagen revoked this relay's token. Mint a new relay token and restart the relay with it.",
    });
    await logs.waitFor("reconnecting");
    await broker.peers.shift();
  });

  it("logs no revoked token for any other close", async () => {
    const { broker, logs } = await setup();
    const peer = await welcomed(broker);
    peer.socket.close(4003, "hello mismatch");
    expect(await logs.waitFor("disconnected")).toMatchObject({ code: 4003 });
    await logs.waitFor("reconnecting");
    expect(logs.named("token_revoked")).toStrictEqual([]);
  });

  it("stops: closes with 1000, closes the upstreams, and never dials again", async () => {
    const { broker, logs, relay, states, upstream } = await setup();
    const peer = await welcomed(broker);
    await logs.waitFor("ready");
    const stopping = relay.stop();
    expect(relay.stop()).toBe(stopping);
    expect(await peer.closed).toEqual({ code: 1000, reason: "The relay is stopping." });
    await stopping;
    expect(relay.state).toBe("stopped");
    expect(states.at(-1)).toBe("stopped");
    expect(upstream.closes).toBe(1);
    expect(logs.named("stopped")).toHaveLength(1);
    expect(logs.named("reconnecting")).toEqual([]);
    await sleep(100);
    expect(broker.upgrades).toBe(1);
  });

  it("stops while it waits out a backoff", async () => {
    const { broker, logs, relay, upstream } = await setup({
      refuse: Number.POSITIVE_INFINITY,
      relay: { backoff: { initialMs: 1_000, maxMs: 1_000 } },
    });
    await logs.waitFor("reconnecting");
    expect(relay.state).toBe("waiting");
    await relay.stop();
    expect(relay.state).toBe("stopped");
    expect(upstream.closes).toBe(1);
    await sleep(100);
    expect(broker.upgrades).toBe(1);
  });

  it("stops before the first dial", async () => {
    const { broker, relay } = await setup({ relay: { startDelayMs: 1_000 } });
    expect(relay.state).toBe("starting");
    await relay.stop();
    expect(relay.state).toBe("stopped");
    await sleep(50);
    expect(broker.upgrades).toBe(0);
  });
});
