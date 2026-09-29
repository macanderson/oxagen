// http.test.ts: the HTTP sender against a node:http server on 127.0.0.1.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Agent as HttpsAgent } from "node:https";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DATA_CHUNK_BYTES } from "@oxagen/relay-broker/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCertificate, HeaderEntry } from "../credentials";
import { testCertificate } from "../test/certificate";
import { RecordingSink, type SinkEvent } from "../test/fixtures";
import { agentFor, createHttpAgents, createHttpUpstream, destroyAgents, type HttpUpstream } from "./http";
import type { RelayHttpTarget } from "./types";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type HeadEvent = Extract<SinkEvent, { kind: "head" }>;

interface TestServer {
  server: Server;
  port: number;
  /** How many connections the server has accepted. */
  connections(): number;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface CallOptions {
  method?: RelayHttpTarget["method"];
  scheme?: RelayHttpTarget["scheme"];
  path?: string;
  headers?: HeaderEntry[];
  body?: string;
  deadlineMs?: number;
  clientCert?: ClientCertificate;
  sink?: RecordingSink;
  controller?: AbortController;
}

interface StartedCall {
  sink: RecordingSink;
  controller: AbortController;
}

interface ReceivedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: HeaderEntry[];
  body: Buffer;
}

const servers: Server[] = [];
const upstreams: HttpUpstream[] = [];
const controllers: AbortController[] = [];

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const upstream of upstreams.splice(0)) upstream.close();
  await Promise.all(
    servers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

async function listen(handler: Handler): Promise<TestServer> {
  const server = createServer(handler);
  servers.push(server);
  let connections = 0;
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { server, port, connections: () => connections };
}

/** A port on 127.0.0.1 with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function newUpstream(): HttpUpstream {
  const upstream = createHttpUpstream();
  upstreams.push(upstream);
  return upstream;
}

function send(upstream: HttpUpstream, port: number, options: CallOptions = {}): StartedCall {
  const sink = options.sink ?? new RecordingSink();
  const controller = options.controller ?? new AbortController();
  controllers.push(controller);
  upstream.send({
    target: {
      kind: "http",
      scheme: options.scheme ?? "http",
      method: options.method ?? "GET",
      host: "127.0.0.1",
      port,
      path: options.path ?? "/",
    },
    headers: options.headers ?? [],
    body: Buffer.from(options.body ?? ""),
    deadlineMs: options.deadlineMs ?? 2_000,
    clientCert: options.clientCert,
    signal: controller.signal,
    sink,
  });
  return { sink, controller };
}

/** A mutual_tls credential's pair, as credentials.ts reads it. */
function clientCert(name = "BILLING_API"): ClientCertificate {
  return { name, ...testCertificate(name.toLowerCase()) };
}

/** A pair that does not load, holding a string no message may quote. */
const BAD_PAIR: ClientCertificate = { name: "BILLING_API", cert: "not a certificate s3cret", key: "not a key s3cret" };

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const part of req as AsyncIterable<Buffer>) parts.push(part);
  return Buffer.concat(parts);
}

/** A raw header list as [lowercase name, value] pairs, in the order they arrived. */
function pairs(raw: readonly string[]): HeaderEntry[] {
  const entries: HeaderEntry[] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) {
    entries.push([(raw[index] ?? "").toLowerCase(), raw[index + 1] ?? ""]);
  }
  return entries;
}

/** Bytes that differ from one position to the next, so a reordered part shows. */
function patterned(length: number): Buffer {
  const bytes = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) bytes[index] = index % 251;
  return bytes;
}

function kinds(sink: RecordingSink): SinkEvent["kind"][] {
  return sink.events.map((event) => event.kind);
}

function dataChunks(sink: RecordingSink): Uint8Array[] {
  return sink.events.flatMap((event) => (event.kind === "data" ? [event.chunk] : []));
}

function headOf(sink: RecordingSink): HeadEvent {
  const head = sink.events.find((event): event is HeadEvent => event.kind === "head");
  if (head === undefined) throw new Error("The sink got no head.");
  return head;
}

/** A handler that sends the head and one part, then keeps writing every 10 ms until the connection closes. */
function trickle(closed: Deferred<void>): Handler {
  return (_req, res) => {
    res.on("error", () => undefined);
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("part 1");
    let count = 1;
    const timer = setInterval(() => {
      if (res.destroyed || res.writableEnded) return;
      count += 1;
      res.write(`part ${count}`);
    }, 10);
    res.on("close", () => {
      clearInterval(timer);
      closed.resolve();
    });
  };
}

describe("createHttpUpstream", () => {
  it("sends exactly the method, path, query, headers, and body, and streams the response back", async () => {
    const received = deferred<ReceivedRequest>();
    const server = await listen((req, res) => {
      void readBody(req).then((body) => {
        received.resolve({ method: req.method, url: req.url, headers: pairs(req.rawHeaders), body });
        res.writeHead(201, { "content-type": "application/json", "x-reply": "yes" });
        res.end('{"id":"inv_1"}');
      });
    });

    const { sink } = send(newUpstream(), server.port, {
      method: "POST",
      path: "/v1/invoices?limit=5&cursor=a%20b",
      headers: [
        ["Content-Type", "application/json"],
        ["x-trace", "t-1"],
        ["X-Multi", "one"],
        ["x-multi", "two"],
      ],
      body: '{"amount":1250}',
    });

    const request = await received.promise;
    expect(request.method).toBe("POST");
    expect(request.url).toBe("/v1/invoices?limit=5&cursor=a%20b");
    expect(request.body.toString()).toBe('{"amount":1250}');
    expect(request.headers).toContainEqual(["content-type", "application/json"]);
    expect(request.headers).toContainEqual(["x-trace", "t-1"]);
    expect(request.headers).toContainEqual(["host", `127.0.0.1:${server.port}`]);
    // Two headers with one name in any case go out as two lines, in order.
    expect(request.headers.filter(([name]) => name === "x-multi")).toEqual([
      ["x-multi", "one"],
      ["x-multi", "two"],
    ]);

    expect(await sink.done).toEqual({ kind: "end" });
    const head = headOf(sink);
    expect(head.status).toBe(201);
    expect(head.headers).toContainEqual(["content-type", "application/json"]);
    expect(head.headers).toContainEqual(["x-reply", "yes"]);
    expect(sink.body().toString()).toBe('{"id":"inv_1"}');
    const order = kinds(sink);
    expect(order[0]).toBe("head");
    expect(order.at(-1)).toBe("end");
    expect(order.slice(1, -1).every((kind) => kind === "data")).toBe(true);
  });

  it("keeps repeated response headers as separate entries, in order", async () => {
    const server = await listen((_req, res) => {
      res.setHeader("set-cookie", ["session=abc; Path=/", "theme=dark; Path=/"]);
      res.end();
    });

    const { sink } = send(newUpstream(), server.port);

    expect(await sink.done).toEqual({ kind: "end" });
    const cookies = headOf(sink).headers.filter(([name]) => name.toLowerCase() === "set-cookie");
    expect(cookies.map(([, value]) => value)).toEqual(["session=abc; Path=/", "theme=dark; Path=/"]);
    expect(kinds(sink)).toEqual(["head", "end"]);
  });

  it("sends a large response in parts no bigger than DATA_CHUNK_BYTES", async () => {
    const payload = patterned(DATA_CHUNK_BYTES * 4 + 123);
    const server = await listen((_req, res) => {
      res.end(payload);
    });
    // The first part waits 50 ms, so more than one socket read can queue up behind it.
    let first = true;
    const sink = new RecordingSink(async () => {
      if (first) {
        first = false;
        await delay(50);
      }
      return true;
    });

    send(newUpstream(), server.port, { sink });

    expect(await sink.done).toEqual({ kind: "end" });
    const chunks = dataChunks(sink);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) expect(chunk.byteLength).toBeLessThanOrEqual(DATA_CHUNK_BYTES);
    expect(sink.body().equals(payload)).toBe(true);
  });

  it("passes a redirect back as it is and does not follow it", async () => {
    const paths: (string | undefined)[] = [];
    const server = await listen((req, res) => {
      paths.push(req.url);
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
    });

    const { sink } = send(newUpstream(), server.port, { path: "/start" });

    expect(await sink.done).toEqual({ kind: "end" });
    expect(headOf(sink).status).toBe(302);
    expect(headOf(sink).headers).toContainEqual(["location", "/elsewhere"]);
    expect(paths).toEqual(["/start"]);
  });

  it("fails with timeout and sent true when the deadline passes before the response", async () => {
    const server = await listen(() => undefined);

    const { sink } = send(newUpstream(), server.port, { deadlineMs: 150 });

    expect(await sink.done).toEqual({
      kind: "fail",
      code: "timeout",
      message: "127.0.0.1 did not finish within the envelope's 150 ms deadline.",
      sent: true,
    });
    expect(kinds(sink)).not.toContain("head");
  });

  it("counts the whole body against the deadline, not only the head", async () => {
    const closed = deferred();
    const server = await listen((_req, res) => {
      res.on("close", () => closed.resolve());
      res.writeHead(200);
      res.write("part 1");
    });

    const { sink } = send(newUpstream(), server.port, { deadlineMs: 200 });

    expect(await sink.done).toMatchObject({ kind: "fail", code: "timeout", sent: true });
    // The sender tears the connection down after it reports the timeout.
    await closed.promise;
    expect(kinds(sink).slice(0, 3)).toEqual(["head", "data", "fail"]);
    expect(sink.body().toString()).toBe("part 1");
  });

  it("fails with upstream and sent false when nothing listens on the port", async () => {
    const port = await closedPort();

    const { sink } = send(newUpstream(), port);

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
    expect(done.kind === "fail" ? done.message : "").toContain("The connection to 127.0.0.1 failed");
    expect(kinds(sink)).toEqual(["fail"]);
  });

  it("fails with upstream and sent true when the server drops the connection mid-response", async () => {
    const responded = deferred<ServerResponse>();
    const server = await listen((_req, res) => {
      res.writeHead(200);
      res.write("part 1");
      responded.resolve(res);
    });
    const firstPart = deferred();
    const sink = new RecordingSink(() => {
      firstPart.resolve();
      return Promise.resolve(true);
    });

    send(newUpstream(), server.port, { sink });
    await firstPart.promise;
    (await responded.promise).socket?.destroy();

    expect(await sink.done).toMatchObject({ kind: "fail", code: "upstream", sent: true });
    expect(sink.body().toString()).toBe("part 1");
  });

  it("stops reading and closes the connection when data() resolves false", async () => {
    const closed = deferred();
    const server = await listen(trickle(closed));
    const sink = new RecordingSink(() => Promise.resolve(false));

    send(newUpstream(), server.port, { sink });
    await closed.promise;

    expect(dataChunks(sink)).toHaveLength(1);
    expect(kinds(sink)).not.toContain("end");
  });

  it("reads the next part only after data() resolves, and keeps the body in order", async () => {
    const payload = patterned(DATA_CHUNK_BYTES * 3 + 500);
    const server = await listen((_req, res) => {
      res.writeHead(200);
      for (let offset = 0; offset < payload.length; offset += 20_000) {
        res.write(payload.subarray(offset, offset + 20_000));
      }
      res.end();
    });
    let inFlight = 0;
    let most = 0;
    const sink = new RecordingSink(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await delay(10);
      inFlight -= 1;
      return true;
    });

    send(newUpstream(), server.port, { sink });

    expect(await sink.done).toEqual({ kind: "end" });
    expect(dataChunks(sink).length).toBeGreaterThan(1);
    expect(most).toBe(1);
    expect(sink.body().equals(payload)).toBe(true);
  });

  it("stops the call and sends no more data when the signal aborts mid-body", async () => {
    const closed = deferred();
    const server = await listen(trickle(closed));
    const controller = new AbortController();
    const sink = new RecordingSink(() => {
      controller.abort();
      return Promise.resolve(true);
    });

    send(newUpstream(), server.port, { sink, controller });
    await closed.promise;

    // A FrameSink closes before its call's signal aborts, so it drops this frame.
    expect(await sink.done).toMatchObject({ kind: "fail", code: "upstream", sent: true });
    expect(dataChunks(sink)).toHaveLength(1);
    expect(kinds(sink)).toEqual(["head", "data", "fail"]);
  });

  it("stops the call when the signal aborts before the response", async () => {
    const arrived = deferred();
    const closed = deferred();
    const server = await listen((_req, res) => {
      res.on("close", () => closed.resolve());
      arrived.resolve();
    });

    const { sink, controller } = send(newUpstream(), server.port);
    await arrived.promise;
    controller.abort();
    await closed.promise;

    // A FrameSink closes before its call's signal aborts, so it drops this frame.
    expect(await sink.done).toMatchObject({ kind: "fail", code: "upstream", sent: true });
    expect(kinds(sink)).toEqual(["fail"]);
  });

  it("sends nothing when the signal has already aborted", async () => {
    let requests = 0;
    const server = await listen(() => {
      requests += 1;
    });
    const controller = new AbortController();
    controller.abort();

    const { sink } = send(newUpstream(), server.port, { controller });
    await delay(30);

    expect(sink.events).toEqual([]);
    expect(requests).toBe(0);
    expect(server.connections()).toBe(0);
  });

  it("fails with upstream and sent false for a header value Node refuses, naming the header but not the value", async () => {
    const server = await listen((_req, res) => res.end());

    const { sink } = send(newUpstream(), server.port, {
      headers: [["authorization", "Bearer s3cret-\u{1F511}-token"]],
    });

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
    const message = done.kind === "fail" ? done.message : "";
    expect(message).toMatch(/^The request is not valid: /);
    expect(message).toContain("authorization");
    expect(message).not.toContain("s3cret");
    expect(server.connections()).toBe(0);
  });

  it("fails with upstream and sent false when an https target answers without TLS", async () => {
    const server = await listen((_req, res) => res.end("plain"));

    const { sink } = send(newUpstream(), server.port, { scheme: "https" });

    expect(await sink.done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
  });

  it("fails with upstream and sent false when an https target with a client certificate answers without TLS", async () => {
    const server = await listen((_req, res) => res.end("plain"));

    const { sink } = send(newUpstream(), server.port, { scheme: "https", clientCert: clientCert() });

    expect(await sink.done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
  });

  it("refuses a client certificate on an http target and opens no connection", async () => {
    const server = await listen((_req, res) => res.end("plain"));

    const { sink } = send(newUpstream(), server.port, { clientCert: clientCert() });

    expect(await sink.done).toEqual({
      kind: "fail",
      code: "upstream",
      message: "Credential BILLING_API presents a client certificate, which needs an https target.",
      sent: false,
    });
    expect(server.connections()).toBe(0);
  });

  it("fails with upstream and sent false when the client certificate does not load, naming only the credential", async () => {
    const server = await listen((_req, res) => res.end("plain"));

    const { sink } = send(newUpstream(), server.port, { scheme: "https", clientCert: BAD_PAIR });

    const done = await sink.done;
    expect(done).toEqual({
      kind: "fail",
      code: "upstream",
      message: "The relay could not load the client certificate for credential BILLING_API.",
      sent: false,
    });
    expect(JSON.stringify(done)).not.toContain("s3cret");
    expect(server.connections()).toBe(0);
  });

  it("reuses a kept-alive connection for the next call", async () => {
    const server = await listen((_req, res) => res.end("ok"));
    const upstream = newUpstream();

    const first = send(upstream, server.port);
    expect(await first.sink.done).toEqual({ kind: "end" });
    // The agent frees the socket on a later tick than the response's end.
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = send(upstream, server.port);

    expect(await second.sink.done).toEqual({ kind: "end" });
    expect(second.sink.body().toString()).toBe("ok");
    expect(server.connections()).toBe(1);
  });

  it("closes its kept-alive connections on close()", async () => {
    const socketClosed = deferred();
    const server = await listen((_req, res) => res.end("ok"));
    server.server.on("connection", (socket) => socket.on("close", () => socketClosed.resolve()));
    const upstream = newUpstream();

    const { sink } = send(upstream, server.port);
    expect(await sink.done).toEqual({ kind: "end" });
    upstream.close();

    await socketClosed.promise;
  });

  it("closes without throwing when no call is in flight", () => {
    const upstream = createHttpUpstream();

    expect(() => upstream.close()).not.toThrow();
    expect(() => upstream.close()).not.toThrow();
  });
});

describe("agentFor", () => {
  it("gives a plain call the http agent and an https call with no certificate the shared https agent", () => {
    const agents = createHttpAgents();

    expect(agentFor(agents, false)).toBe(agents.http);
    expect(agentFor(agents, true)).toBe(agents.https);
    expect(agents.mutual.size).toBe(0);
    destroyAgents(agents);
  });

  it("makes one agent per credential, reuses it, and loads that credential's pair into it", () => {
    const agents = createHttpAgents();
    const billing = clientCert("BILLING_API");
    const ledger = clientCert("LEDGER_API");

    const first = agentFor(agents, true, billing);

    expect(agentFor(agents, true, billing)).toBe(first);
    expect(first).not.toBe(agents.https);
    expect((first as HttpsAgent).options).toMatchObject({ cert: billing.cert, key: billing.key, keepAlive: true });
    const second = agentFor(agents, true, ledger);
    expect(second).not.toBe(first);
    expect((second as HttpsAgent).options).toMatchObject({ cert: ledger.cert, key: ledger.key });
    expect([...agents.mutual.keys()]).toEqual(["BILLING_API", "LEDGER_API"]);
    destroyAgents(agents);
  });

  it("throws before it makes an agent when the pair does not load", () => {
    const agents = createHttpAgents();

    expect(() => agentFor(agents, true, BAD_PAIR)).toThrow();
    expect(agents.mutual.size).toBe(0);
    destroyAgents(agents);
  });

  it("gives a call with a certificate but no TLS the http agent, and makes no agent for it", () => {
    const agents = createHttpAgents();

    expect(agentFor(agents, false, clientCert())).toBe(agents.http);
    expect(agents.mutual.size).toBe(0);
    destroyAgents(agents);
  });
});

describe("destroyAgents", () => {
  it("destroys every agent and forgets the per-credential ones", () => {
    const agents = createHttpAgents();
    const mutual = agentFor(agents, true, clientCert());
    const destroyed = [vi.spyOn(agents.http, "destroy"), vi.spyOn(agents.https, "destroy"), vi.spyOn(mutual, "destroy")];

    destroyAgents(agents);

    for (const destroy of destroyed) expect(destroy).toHaveBeenCalledTimes(1);
    expect(agents.mutual.size).toBe(0);
    vi.restoreAllMocks();
  });
});
