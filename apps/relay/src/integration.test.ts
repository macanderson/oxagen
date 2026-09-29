// The relay and the broker together over loopback.
//
// A real broker (createRelayBroker) signs each envelope and mounts on an HTTP
// server on 127.0.0.1. A real relay (startRelay) dials it, checks every
// envelope, and sends the call to a loopback HTTP server or a grpc-js server
// with its real upstreams. Nothing in between is faked.
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  Metadata,
  Server as GrpcServer,
  ServerCredentials,
  status as grpcCode,
  type MethodDefinition,
  type sendUnaryData,
  type ServerUnaryCall,
} from "@grpc/grpc-js";
import {
  TransportError,
  type GrpcTarget,
  type GrpcTransportRequest,
  type HttpTarget,
  type HttpTransportRequest,
  type Transport,
} from "@oxagen/mcp-studio";
import {
  createRelayBroker,
  generateRelayToken,
  hashRelayToken,
  memoryRelayTokenVerifier,
  relaySignerFromPem,
  type RelayBroker,
  type RelayScope,
  type RelayStatusEvent,
} from "@oxagen/relay-broker";
import { RELAY_CONNECT_PATH } from "@oxagen/relay-broker/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelayConfig } from "./config";
import { startRelay, type RelayHandle } from "./connection";
import type { RelayLogFields } from "./log";
import { RELAY, WORKSPACE } from "./test/fixtures";

const scope: RelayScope = { orgId: "org-1", workspaceId: "ws-1", workspacePublicId: WORKSPACE, planTier: "enterprise" };
const NETWORK = `relay:${RELAY}`;
const LEDGER_SERVICE = "a_intel.ledger.v1.Ledger";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function listen(server: HttpServer): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function closeHttp(server: HttpServer): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface HttpUpstream {
  port: number;
  seen: SeenRequest[];
  /** How many /hang requests lost their connection before any answer. */
  hangsDropped: () => number;
  /** Let /events write its second event. */
  releaseEvents: () => void;
}

/**
 * A loopback HTTP server with five routes:
 * /echo answers 201 with the body it got, /events streams two events and
 * waits for releaseEvents() between them, /hang never answers, /big sends
 * 16 KiB, and anything else is 404.
 */
async function startHttpUpstream(): Promise<HttpUpstream> {
  const seen: SeenRequest[] = [];
  let dropped = 0;
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8");
      seen.push({ method: request.method ?? "", url: request.url ?? "", headers: request.headers, body });
      const path = (request.url ?? "").split("?")[0];
      switch (path) {
        case "/echo":
          response.writeHead(201, { "Content-Type": "application/json", "X-Upstream": "billing" });
          response.end(JSON.stringify({ got: body }));
          return;
        case "/events":
          response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
          response.write('event: message\ndata: {"n":1}\n\n');
          void released.then(() => response.end('event: message\ndata: {"n":2}\n\n'));
          return;
        case "/hang":
          response.on("close", () => {
            if (!response.writableEnded) dropped += 1;
          });
          return;
        case "/big":
          response.writeHead(200, { "Content-Type": "application/octet-stream" });
          response.end(Buffer.alloc(16 * 1024, 120));
          return;
        default:
          response.writeHead(404);
          response.end();
      }
    });
  });
  const port = await listen(server);
  cleanups.push(() => closeHttp(server));
  return { port, seen, hangsDropped: () => dropped, releaseEvents: () => release() };
}

interface SeenGrpcCall {
  path: string;
  message: Buffer;
  metadata: Record<string, string>;
}

interface GrpcUpstream {
  port: number;
  seen: SeenGrpcCall[];
}

const rawBytes = (value: Buffer): Buffer => value;

function unaryMethod(name: string): MethodDefinition<Buffer, Buffer> {
  return {
    path: `/${LEDGER_SERVICE}/${name}`,
    requestStream: false,
    responseStream: false,
    requestSerialize: rawBytes,
    requestDeserialize: rawBytes,
    responseSerialize: rawBytes,
    responseDeserialize: rawBytes,
  };
}

function textMetadata(metadata: Metadata): Record<string, string> {
  const record: Record<string, string> = {};
  for (const [name, value] of Object.entries(metadata.getMap())) {
    if (typeof value === "string") record[name] = value;
  }
  return record;
}

/**
 * A grpc-js server for a_intel.ledger.v1.Ledger that takes raw bytes, so the
 * test needs no .proto. PostEntry answers "posted:" and the request bytes.
 * Missing answers NOT_FOUND.
 */
async function startGrpcUpstream(): Promise<GrpcUpstream> {
  const seen: SeenGrpcCall[] = [];
  const server = new GrpcServer();
  const record = (name: string, call: ServerUnaryCall<Buffer, Buffer>): void => {
    seen.push({ path: `/${LEDGER_SERVICE}/${name}`, message: call.request, metadata: textMetadata(call.metadata) });
  };
  server.addService(
    { PostEntry: unaryMethod("PostEntry"), Missing: unaryMethod("Missing") },
    {
      PostEntry: (call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>) => {
        record("PostEntry", call);
        const reply = new Metadata();
        reply.set("x-ledger-region", "east");
        call.sendMetadata(reply);
        callback(null, Buffer.concat([Buffer.from("posted:"), call.request]));
      },
      Missing: (call: ServerUnaryCall<Buffer, Buffer>, callback: sendUnaryData<Buffer>) => {
        record("Missing", call);
        callback({ code: grpcCode.NOT_FOUND, details: "No entry 42." });
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) => {
      if (error) reject(error);
      else resolve(bound);
    });
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.tryShutdown(() => resolve());
        // A call the relay left open would hold tryShutdown, so force it after a moment.
        setTimeout(() => {
          server.forceShutdown();
          resolve();
        }, 500).unref();
      }),
  );
  return { port, seen };
}

interface Harness {
  broker: RelayBroker;
  transport: Transport;
  relay: RelayHandle;
  statuses: RelayStatusEvent[];
  logs: { event: string; fields: RelayLogFields }[];
  http: HttpUpstream;
  grpc: GrpcUpstream;
  /** Drop every connection the broker's server holds, as a network failure would. */
  dropConnections: () => void;
}

interface HarnessOptions {
  maxResponseBytes?: number;
  credentials?: ReadonlyMap<string, string>;
}

async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const http = await startHttpUpstream();
  const grpc = await startGrpcUpstream();

  const token = generateRelayToken();
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signer = relaySignerFromPem(pem);
  const statuses: RelayStatusEvent[] = [];
  const broker = createRelayBroker({
    verifier: memoryRelayTokenVerifier([
      { orgId: scope.orgId, workspaceId: scope.workspaceId, workspacePublicId: WORKSPACE, relay: RELAY, tokenHash: hashRelayToken(token) },
    ]),
    signer,
    credentialEntitled: () => Promise.resolve(true),
    onStatus: (event) => statuses.push(event),
  });
  const upgrades = new Set<Duplex>();
  const server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket: Duplex, head: Buffer) => {
    upgrades.add(socket);
    socket.once("close", () => upgrades.delete(socket));
    void broker.handleUpgrade(request, socket, head);
  });
  const brokerPort = await listen(server);
  cleanups.push(async () => {
    await broker.close();
    await closeHttp(server);
  });

  const config: RelayConfig = {
    brokerUrl: `ws://127.0.0.1:${brokerPort}${RELAY_CONNECT_PATH}`,
    token,
    relay: RELAY,
    workspace: WORKSPACE,
    trustedKeys: new Map([[signer.keyId, createPublicKey(signer.publicKeyPem)]]),
    allowedHosts: { exact: new Set([`127.0.0.1:${http.port}`, `127.0.0.1:${grpc.port}`]), defaultPort: new Set() },
    clockSkewMs: 0,
    maxResponseBytes: options.maxResponseBytes ?? 1024 * 1024,
    credentials: options.credentials ?? new Map(),
  };
  const logs: Harness["logs"] = [];
  const relay = startRelay({
    config,
    version: "integration-test",
    startDelayMs: 0,
    backoff: { initialMs: 20, maxMs: 100 },
    random: () => 0,
    log: (event, fields = {}) => logs.push({ event, fields }),
  });
  // Stopped first, so the relay does not dial the broker as it closes.
  cleanups.push(() => relay.stop());

  // The broker counts the relay up once it sends welcome, a moment before the relay reads it.
  await vi.waitFor(
    () => {
      expect(broker.status(scope, RELAY)).toBe("up");
      expect(relay.state).toBe("ready");
    },
    { timeout: 5_000, interval: 10 },
  );
  return {
    broker,
    transport: broker.transport(scope),
    relay,
    statuses,
    logs,
    http,
    grpc,
    dropConnections: () => {
      for (const socket of upgrades) socket.destroy();
    },
  };
}

function httpTarget(port: number, path: string, method: HttpTarget["method"] = "POST"): HttpTarget {
  return { kind: "http", scheme: "http", method, host: "127.0.0.1", port, path };
}

function httpRequest(target: HttpTarget, overrides: Partial<HttpTransportRequest> = {}): HttpTransportRequest {
  return {
    network: NETWORK,
    target,
    headers: [
      ["content-type", "application/json"],
      ["x-request-id", "req-7"],
    ],
    body: new TextEncoder().encode('{"customer":"c-9"}'),
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    ...overrides,
  };
}

function grpcRequest(port: number, method: string, overrides: Partial<GrpcTransportRequest> = {}): GrpcTransportRequest {
  const target: GrpcTarget = { kind: "grpc", scheme: "http", host: "127.0.0.1", port, service: LEDGER_SERVICE, method };
  return {
    network: NETWORK,
    target,
    metadata: [["x-trace-id", "t-1"]],
    message: new Uint8Array([10, 3, 97, 99, 99]),
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    ...overrides,
  };
}

async function readAll(parts: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const buffers: Buffer[] = [];
  for await (const part of parts) buffers.push(Buffer.from(part));
  return Buffer.concat(buffers);
}

function header(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  return headers.find(([key]) => key.toLowerCase() === name)?.[1];
}

async function transportError(promise: Promise<unknown>): Promise<TransportError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(TransportError);
  return error as TransportError;
}

describe("a relay connected to an in-process broker", () => {
  it("is reported up once the broker welcomes it", async () => {
    const h = await startHarness();
    expect(h.relay.state).toBe("ready");
    expect(h.statuses.map((event) => [event.relay, event.status])).toEqual([[RELAY, "up"]]);
  });

  it("carries an HTTP request to the upstream and its response back", async () => {
    const h = await startHarness();
    const response = await h.transport.http(httpRequest(httpTarget(h.http.port, "/echo?limit=5")));
    expect(response.status).toBe(201);
    expect(header(response.headers, "x-upstream")).toBe("billing");
    expect(JSON.parse((await readAll(response.body)).toString("utf8"))).toEqual({ got: '{"customer":"c-9"}' });

    expect(h.http.seen).toHaveLength(1);
    const seen = h.http.seen[0];
    expect(seen?.method).toBe("POST");
    expect(seen?.url).toBe("/echo?limit=5");
    expect(seen?.headers["x-request-id"]).toBe("req-7");
    expect(seen?.body).toBe('{"customer":"c-9"}');
  });

  it("streams an MCP event stream as the upstream writes it", async () => {
    const h = await startHarness();
    const response = await h.transport.http(
      httpRequest(httpTarget(h.http.port, "/events", "GET"), { headers: [["accept", "text/event-stream"]], body: new Uint8Array() }),
    );
    expect(response.status).toBe(200);
    expect(header(response.headers, "content-type")).toBe("text/event-stream");

    const reader = response.body[Symbol.asyncIterator]();
    const first = await reader.next();
    // The upstream has not written the second event yet, so the first arrived on its own.
    if (first.done === true) throw new Error("The event stream ended before its first event.");
    expect(Buffer.from(first.value).toString("utf8")).toBe('event: message\ndata: {"n":1}\n\n');

    h.http.releaseEvents();
    const rest: Buffer[] = [];
    for (let next = await reader.next(); next.done !== true; next = await reader.next()) rest.push(Buffer.from(next.value));
    expect(Buffer.concat(rest).toString("utf8")).toBe('event: message\ndata: {"n":2}\n\n');
  });

  it("carries a gRPC call to the service and method the envelope names", async () => {
    const h = await startHarness();
    const response = await h.transport.grpc(grpcRequest(h.grpc.port, "PostEntry"));
    const messages: Buffer[] = [];
    for await (const message of response.messages) messages.push(Buffer.from(message));
    const status = await response.status();

    expect(status.code).toBe(0);
    expect(messages).toEqual([Buffer.concat([Buffer.from("posted:"), Buffer.from([10, 3, 97, 99, 99])])]);
    expect(h.grpc.seen).toEqual([
      {
        path: `/${LEDGER_SERVICE}/PostEntry`,
        message: Buffer.from([10, 3, 97, 99, 99]),
        metadata: expect.objectContaining({ "x-trace-id": "t-1" }) as Record<string, string>,
      },
    ]);
  });

  it("returns the status of a gRPC call the upstream fails", async () => {
    const h = await startHarness();
    const response = await h.transport.grpc(grpcRequest(h.grpc.port, "Missing"));
    const messages = await readAll(response.messages);
    const status = await response.status();

    expect(messages.byteLength).toBe(0);
    expect(status.code).toBe(grpcCode.NOT_FOUND);
    expect(status.message).toBe("No entry 42.");
    expect(h.grpc.seen.map((call) => call.path)).toEqual([`/${LEDGER_SERVICE}/Missing`]);
  });

  it("refuses a host the relay's allowlist does not name, and sends nothing", async () => {
    const h = await startHarness();
    const error = await transportError(h.transport.http(httpRequest(httpTarget(1, "/echo"))));
    expect(error.code).toBe("refused_host");
    expect(error.sent).toBe(false);
    expect(error.message).toContain("host_not_allowed");
    expect(h.logs).toContainEqual({ event: "refused", fields: expect.objectContaining({ code: "host_not_allowed" }) as RelayLogFields });
    expect(h.http.seen).toHaveLength(0);
  });

  it("times out a call the upstream never answers", async () => {
    const h = await startHarness();
    const started = Date.now();
    const error = await transportError(h.transport.http(httpRequest(httpTarget(h.http.port, "/hang"), { deadline_ms: 200 })));
    expect(error.code).toBe("timeout");
    expect(error.sent).toBe(true);
    // The relay's own timer ends the call at the deadline, before the broker's grace runs out.
    expect(Date.now() - started).toBeLessThan(2_000);
    await vi.waitFor(() => expect(h.http.hangsDropped()).toBe(1), { timeout: 2_000, interval: 10 });
  });

  it("adds a credential from the relay's environment when the envelope names one", async () => {
    const h = await startHarness({ credentials: new Map([["RELAY_CREDENTIAL_BILLING_API_TOKEN", "s3cret-token"]]) });
    const response = await h.transport.http(
      httpRequest(httpTarget(h.http.port, "/echo"), { relay_credential: { name: "billing-api", scheme: "bearer" } }),
    );
    expect(response.status).toBe(201);
    await readAll(response.body);
    expect(h.http.seen[0]?.headers.authorization).toBe("Bearer s3cret-token");
  });

  it("refuses a call whose credential the relay does not hold, and sends nothing", async () => {
    const h = await startHarness();
    const error = await transportError(
      h.transport.http(httpRequest(httpTarget(h.http.port, "/echo"), { relay_credential: { name: "payroll", scheme: "bearer" } })),
    );
    expect(error.code).toBe("not_sent");
    expect(error.message).toContain("RELAY_CREDENTIAL_PAYROLL_TOKEN");
    expect(h.http.seen).toHaveLength(0);
  });

  it("stops a response that passes the relay's size cap", async () => {
    const h = await startHarness({ maxResponseBytes: 4_096 });
    const outcome = h.transport.http(httpRequest(httpTarget(h.http.port, "/big", "GET"), { body: new Uint8Array() }));
    await expect(outcome.then((response) => readAll(response.body))).rejects.toThrow(/too_large/);
  });

  it("fails closed once the relay stops: the broker reports it down and sends nothing", async () => {
    const h = await startHarness();
    await h.relay.stop();
    await vi.waitFor(() => expect(h.broker.status(scope, RELAY)).toBe("down"), { timeout: 5_000, interval: 10 });

    const error = await transportError(h.transport.http(httpRequest(httpTarget(h.http.port, "/echo"))));
    expect(error.code).toBe("disconnected");
    expect(error.sent).toBe(false);
    expect(h.http.seen).toHaveLength(0);
    expect(h.statuses.map((event) => event.status)).toEqual(["up", "down"]);
  });

  it("stops a call in flight when the connection drops, then reconnects and carries calls again", async () => {
    const h = await startHarness();
    const pending = transportError(h.transport.http(httpRequest(httpTarget(h.http.port, "/hang"))));
    await vi.waitFor(() => expect(h.http.seen).toHaveLength(1), { timeout: 2_000, interval: 10 });

    h.dropConnections();
    const error = await pending;
    expect(error.code).toBe("disconnected");
    // Fail closed: the relay closes the upstream request instead of letting it run.
    await vi.waitFor(() => expect(h.http.hangsDropped()).toBe(1), { timeout: 2_000, interval: 10 });
    expect(h.logs).toContainEqual({ event: "disconnected", fields: expect.objectContaining({ calls_stopped: 1 }) as RelayLogFields });

    await vi.waitFor(() => expect(h.statuses.map((event) => event.status)).toEqual(["up", "down", "up"]), {
      timeout: 5_000,
      interval: 10,
    });
    const response = await h.transport.http(httpRequest(httpTarget(h.http.port, "/echo")));
    expect(response.status).toBe(201);
    await readAll(response.body);
  });
});
