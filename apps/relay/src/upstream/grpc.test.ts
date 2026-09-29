// grpc.test.ts: the gRPC sender and its metadata helpers, against a grpc-js server on 127.0.0.1.
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import {
  Client,
  credentials,
  Metadata,
  Server,
  ServerCredentials,
  status as grpcStatus,
  type MethodDefinition,
  type ServerWritableStream,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from "@grpc/grpc-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCertificate, HeaderEntry } from "../credentials";
import { testCertificate } from "../test/certificate";
import { RecordingSink, type SinkEvent } from "../test/fixtures";
import {
  createGrpcUpstream,
  grpcChannelCredentials,
  grpcDialAddress,
  grpcMetadata,
  metadataEntries,
  type GrpcUpstream,
} from "./grpc";
import type { RelayGrpcTarget } from "./types";

type Call = ServerWritableStream<Buffer, Buffer>;
type Handler = (call: Call) => void;
type HeadEvent = Extract<SinkEvent, { kind: "head" }>;

interface TestServer {
  port: number;
  /** Every call the server received, in order. */
  calls: Call[];
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface CallOptions {
  method?: string;
  scheme?: RelayGrpcTarget["scheme"];
  headers?: HeaderEntry[];
  body?: Uint8Array;
  deadlineMs?: number;
  clientCert?: ClientCertificate;
  sink?: RecordingSink;
  controller?: AbortController;
}

interface StartedCall {
  sink: RecordingSink;
  controller: AbortController;
}

const SERVICE = "a_intel.ledger.v1.Ledger";
const identity = (bytes: Buffer): Buffer => bytes;

/** A server-streaming method that passes bytes through, so no generated code is needed. */
const LIST_ENTRIES: MethodDefinition<Buffer, Buffer> = {
  path: `/${SERVICE}/ListEntries`,
  requestStream: false,
  responseStream: true,
  requestSerialize: identity,
  requestDeserialize: identity,
  responseSerialize: identity,
  responseDeserialize: identity,
};

const servers: Server[] = [];
const upstreams: GrpcUpstream[] = [];
const controllers: AbortController[] = [];

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const upstream of upstreams.splice(0)) upstream.close();
  for (const server of servers.splice(0)) server.forceShutdown();
  vi.restoreAllMocks();
});

function deferred<T = void>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Serve ListEntries on 127.0.0.1 and a free port. Any other method ends with UNIMPLEMENTED. */
async function startServer(handler: Handler): Promise<TestServer> {
  const calls: Call[] = [];
  const server = new Server();
  servers.push(server);
  const definition: ServiceDefinition = { ListEntries: LIST_ENTRIES };
  const implementation: UntypedServiceImplementation = {
    ListEntries: (call: Call): void => {
      calls.push(call);
      handler(call);
    },
  };
  server.addService(definition, implementation);
  const port = await new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, bound) =>
      error === null ? resolve(bound) : reject(error),
    );
  });
  return { port, calls };
}

/** A port on 127.0.0.1 with nothing listening on it. */
async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function newUpstream(maxResponseBytes = 1024 * 1024): GrpcUpstream {
  const upstream = createGrpcUpstream({ maxResponseBytes });
  upstreams.push(upstream);
  return upstream;
}

function send(upstream: GrpcUpstream, port: number, options: CallOptions = {}): StartedCall {
  const sink = options.sink ?? new RecordingSink();
  const controller = options.controller ?? new AbortController();
  controllers.push(controller);
  upstream.send({
    target: {
      kind: "grpc",
      scheme: options.scheme ?? "http",
      host: "127.0.0.1",
      port,
      service: SERVICE,
      method: options.method ?? "ListEntries",
    },
    headers: options.headers ?? [],
    body: options.body ?? Buffer.from("request"),
    deadlineMs: options.deadlineMs ?? 2_000,
    clientCert: options.clientCert,
    signal: controller.signal,
    sink,
  });
  return { sink, controller };
}

/** A mutual_tls credential's pair, as credentials.ts reads it. */
function clientCert(name = "LEDGER_API"): ClientCertificate {
  return { name, ...testCertificate(name.toLowerCase()) };
}

/** A pair that does not load, holding a string no message may quote. */
const BAD_PAIR: ClientCertificate = { name: "LEDGER_API", cert: "not a certificate s3cret", key: "not a key s3cret" };

function only<T>(items: readonly T[]): T {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error("Expected exactly one item.");
  return item;
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

function trailerMetadata(event: SinkEvent): HeaderEntry[] {
  return event.kind === "trailers" ? event.metadata : [];
}

describe("createGrpcUpstream", () => {
  it("sends the request message and metadata, and streams each message back before the trailers", async () => {
    const signature = Buffer.from([0, 1, 2, 250, 255]);
    const server = await startServer((call) => {
      const reply = new Metadata();
      reply.add("x-reply", "yes");
      reply.add("x-reply-bin", Buffer.from([1, 2, 3]));
      call.sendMetadata(reply);
      for (const message of ["one", "two", "three"]) call.write(Buffer.from(message));
      const trailers = new Metadata();
      trailers.add("x-done", "1");
      call.end(trailers);
    });
    // The message is a view into a larger buffer, so a serializer that ignored byteOffset would send the wrong bytes.
    const framed = Buffer.from("xx|request|yy");

    const { sink } = send(newUpstream(), server.port, {
      headers: [
        ["authorization", "Bearer t-1"],
        ["X-Trace", "trace-1"],
        ["x-sig-bin", signature.toString("base64")],
      ],
      body: framed.subarray(3, 10),
    });

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });
    expect(trailerMetadata(done)).toContainEqual(["x-done", "1"]);

    const call = only(server.calls);
    expect(call.request.toString()).toBe("request");
    expect(call.metadata.get("authorization")).toEqual(["Bearer t-1"]);
    expect(call.metadata.get("x-trace")).toEqual(["trace-1"]);
    expect(call.metadata.get("x-sig-bin")).toEqual([signature]);

    expect(kinds(sink)).toEqual(["head", "data", "data", "data", "trailers"]);
    const head = headOf(sink);
    expect(head.status).toBe(200);
    expect(head.headers).toContainEqual(["x-reply", "yes"]);
    expect(head.headers).toContainEqual(["x-reply-bin", Buffer.from([1, 2, 3]).toString("base64")]);
    expect(dataChunks(sink).map((chunk) => Buffer.from(chunk).toString())).toEqual(["one", "two", "three"]);
  });

  it("reads the next message only after data() resolves, and still sends the trailers last", async () => {
    const server = await startServer((call) => {
      for (const message of ["one", "two", "three"]) call.write(Buffer.from(message));
      call.end();
    });
    let inFlight = 0;
    let most = 0;
    const sink = new RecordingSink(async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await delay(20);
      inFlight -= 1;
      return true;
    });

    send(newUpstream(), server.port, { sink });

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });
    expect(kinds(sink)).toEqual(["head", "data", "data", "data", "trailers"]);
    expect(most).toBe(1);
    expect(sink.body().toString()).toBe("onetwothree");
  });

  it("passes an error status, its details, and its metadata to the trailers", async () => {
    const server = await startServer((call) => {
      const metadata = new Metadata();
      metadata.add("x-reason", "missing");
      call.emit("error", { code: grpcStatus.NOT_FOUND, details: "no entry 42", metadata });
    });

    const { sink } = send(newUpstream(), server.port);

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "trailers", code: grpcStatus.NOT_FOUND, message: "no entry 42" });
    expect(trailerMetadata(done)).toContainEqual(["x-reason", "missing"]);
    expect(dataChunks(sink)).toEqual([]);
  });

  it("ends with UNIMPLEMENTED when the server has no such method", async () => {
    const server = await startServer(() => undefined);

    const { sink } = send(newUpstream(), server.port, { method: "Missing" });

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.UNIMPLEMENTED });
    expect(server.calls).toHaveLength(0);
  });

  it("fails with timeout and sent true when the call outlives its deadline, and cancels it", async () => {
    const cancelled = deferred();
    const server = await startServer((call) => {
      call.once("cancelled", () => cancelled.resolve());
    });

    const { sink } = send(newUpstream(), server.port, { deadlineMs: 200 });

    expect(await sink.done).toEqual({
      kind: "fail",
      code: "timeout",
      message: "127.0.0.1 did not finish the call within the envelope's 200 ms deadline.",
      sent: true,
    });
    await cancelled.promise;
    expect(server.calls).toHaveLength(1);
  });

  it("ends with RESOURCE_EXHAUSTED when one message is larger than maxResponseBytes", async () => {
    const server = await startServer((call) => {
      call.write(Buffer.alloc(2048, 7));
      call.end();
    });

    const { sink } = send(newUpstream(1024), server.port);

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.RESOURCE_EXHAUSTED });
    expect(dataChunks(sink)).toEqual([]);
  });

  it("accepts a message of exactly maxResponseBytes", async () => {
    const server = await startServer((call) => {
      call.write(Buffer.alloc(1024, 7));
      call.end();
    });

    const { sink } = send(newUpstream(1024), server.port);

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });
    expect(sink.body().equals(Buffer.alloc(1024, 7))).toBe(true);
  });

  it("cancels the call when the signal aborts, and the server sees it cancelled", async () => {
    const arrived = deferred();
    const cancelled = deferred();
    const server = await startServer((call) => {
      call.once("cancelled", () => cancelled.resolve());
      arrived.resolve();
    });

    const { sink, controller } = send(newUpstream(), server.port);
    await arrived.promise;
    controller.abort();
    await cancelled.promise;

    // A FrameSink closes before its call's signal aborts, so it drops this frame.
    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.CANCELLED });
    expect(dataChunks(sink)).toEqual([]);
  });

  it("cancels the call when data() resolves false", async () => {
    const cancelled = deferred();
    const server = await startServer((call) => {
      call.once("cancelled", () => cancelled.resolve());
      for (let count = 1; count <= 5; count += 1) call.write(Buffer.from(`part ${count}`));
    });
    const sink = new RecordingSink(() => Promise.resolve(false));

    send(newUpstream(), server.port, { sink });
    await cancelled.promise;

    expect(dataChunks(sink)).toHaveLength(1);
    expect(sink.body().toString()).toBe("part 1");
  });

  it("cancels the call when data() rejects", async () => {
    const cancelled = deferred();
    const server = await startServer((call) => {
      call.once("cancelled", () => cancelled.resolve());
      for (let count = 1; count <= 5; count += 1) call.write(Buffer.from(`part ${count}`));
    });
    const sink = new RecordingSink(() => Promise.reject(new Error("The broker connection closed.")));

    send(newUpstream(), server.port, { sink });
    await cancelled.promise;

    expect(dataChunks(sink)).toHaveLength(1);
  });

  it("fails with upstream and sent false when a metadata name is not legal, and starts no call", async () => {
    const server = await startServer(() => undefined);
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");

    const { sink } = send(newUpstream(), server.port, { headers: [["bad key", "value"]] });

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
    expect(done.kind === "fail" ? done.message : "").toBe("The call metadata holds a name or value gRPC cannot send.");
    expect(kinds(sink)).toEqual(["fail"]);
    expect(request).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  // grpc-js's own message quotes the refused value, which could be a customer credential.
  it("fails with upstream and sent false when grpc-js refuses a metadata value, without quoting it", async () => {
    const server = await startServer(() => undefined);

    const { sink } = send(newUpstream(), server.port, { headers: [["authorization", "Bearer sécret"]] });

    const done = await sink.done;
    expect(done).toMatchObject({ kind: "fail", code: "upstream", sent: false });
    expect(server.calls).toHaveLength(0);
    expect(done.kind === "fail" ? done.message : "").not.toContain("sécret");
  });

  it("sends nothing when the signal has already aborted", async () => {
    const server = await startServer(() => undefined);
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");
    const controller = new AbortController();
    controller.abort();

    const { sink } = send(newUpstream(), server.port, { controller });
    await delay(30);

    expect(sink.events).toEqual([]);
    expect(request).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  it("ends with UNAVAILABLE when an https target answers without TLS", async () => {
    const server = await startServer(() => undefined);

    const { sink } = send(newUpstream(), server.port, { scheme: "https", deadlineMs: 1_500 });

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.UNAVAILABLE });
    expect(server.calls).toHaveLength(0);
  });

  it("ends with UNAVAILABLE when an https target with a client certificate answers without TLS", async () => {
    const server = await startServer(() => undefined);

    const { sink } = send(newUpstream(), server.port, { scheme: "https", clientCert: clientCert(), deadlineMs: 1_500 });

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.UNAVAILABLE });
    expect(server.calls).toHaveLength(0);
  });

  it("refuses a client certificate on an http target and starts no call", async () => {
    const server = await startServer(() => undefined);
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");

    const { sink } = send(newUpstream(), server.port, { clientCert: clientCert() });

    expect(await sink.done).toEqual({
      kind: "fail",
      code: "upstream",
      message: "Credential LEDGER_API presents a client certificate, which needs an https target.",
      sent: false,
    });
    expect(request).not.toHaveBeenCalled();
    expect(server.calls).toHaveLength(0);
  });

  it("fails with upstream and sent false when the client certificate does not load, naming only the credential", async () => {
    const server = await startServer(() => undefined);
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");

    const { sink } = send(newUpstream(), server.port, { scheme: "https", clientCert: BAD_PAIR });

    const done = await sink.done;
    expect(done).toEqual({
      kind: "fail",
      code: "upstream",
      message: "The relay could not load the client certificate for credential LEDGER_API.",
      sent: false,
    });
    expect(JSON.stringify(done)).not.toContain("s3cret");
    expect(request).not.toHaveBeenCalled();
  });

  it("fails with upstream and sent false, naming the host, when TLS cannot be set up without a certificate", async () => {
    const server = await startServer(() => undefined);
    vi.spyOn(credentials, "createSsl").mockImplementation(() => {
      throw new Error("no roots s3cret");
    });

    const { sink } = send(newUpstream(), server.port, { scheme: "https" });

    const done = await sink.done;
    expect(done).toEqual({
      kind: "fail",
      code: "upstream",
      message: "The relay could not set up TLS for 127.0.0.1.",
      sent: false,
    });
    expect(JSON.stringify(done)).not.toContain("s3cret");
  });

  it("ends with UNAVAILABLE trailers, not a fail, when nothing listens on the port", async () => {
    const port = await closedPort();

    const { sink } = send(newUpstream(), port);

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.UNAVAILABLE });
  });

  it("closes the client of a call still in flight, once", async () => {
    const arrived = deferred();
    const server = await startServer(() => arrived.resolve());
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");
    const close = vi.spyOn(Client.prototype, "close");
    const upstream = newUpstream();

    send(upstream, server.port);
    await arrived.promise;
    const client = only(request.mock.contexts);
    const closes = (): number => close.mock.contexts.filter((context) => context === client).length;

    expect(closes()).toBe(0);
    upstream.close();
    expect(closes()).toBe(1);
    upstream.close();
    expect(closes()).toBe(1);
  });

  it("closes a finished call's client when the call ends, and not again on close()", async () => {
    const server = await startServer((call) => {
      call.write(Buffer.from("one"));
      call.end();
    });
    const request = vi.spyOn(Client.prototype, "makeServerStreamRequest");
    const close = vi.spyOn(Client.prototype, "close");
    const upstream = newUpstream();

    const { sink } = send(upstream, server.port);
    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });
    const client = only(request.mock.contexts);
    const closes = (): number => close.mock.contexts.filter((context) => context === client).length;

    expect(closes()).toBe(1);
    upstream.close();
    expect(closes()).toBe(1);
  });

  it("closes without throwing when no call is in flight", () => {
    const upstream = createGrpcUpstream({ maxResponseBytes: 1024 });

    expect(() => upstream.close()).not.toThrow();
    expect(() => upstream.close()).not.toThrow();
  });
});

describe("grpcDialAddress", () => {
  const target: RelayGrpcTarget = {
    kind: "grpc",
    scheme: "http",
    host: "ledger.internal",
    service: SERVICE,
    method: "PostEntry",
  };

  it("dials the host by name at the target's port", () => {
    expect(grpcDialAddress({ ...target, port: 50051 })).toBe("dns:ledger.internal:50051");
  });

  it("dials port 443 for an https target with no port", () => {
    expect(grpcDialAddress({ ...target, scheme: "https" })).toBe("dns:ledger.internal:443");
  });

  it("dials port 80 for an http target with no port", () => {
    expect(grpcDialAddress(target)).toBe("dns:ledger.internal:80");
  });
});

describe("grpcChannelCredentials", () => {
  const target: RelayGrpcTarget = {
    kind: "grpc",
    scheme: "https",
    host: "ledger.internal",
    service: SERVICE,
    method: "PostEntry",
  };

  it("gives an http target insecure credentials, even with a certificate", () => {
    const createSsl = vi.spyOn(credentials, "createSsl");

    expect(grpcChannelCredentials({ ...target, scheme: "http" })._isSecure()).toBe(false);
    expect(grpcChannelCredentials({ ...target, scheme: "http" }, clientCert())._isSecure()).toBe(false);
    expect(createSsl).not.toHaveBeenCalled();
  });

  it("gives an https target TLS with the default roots and no client certificate", () => {
    const createSsl = vi.spyOn(credentials, "createSsl");

    expect(grpcChannelCredentials(target)._isSecure()).toBe(true);
    expect(createSsl).toHaveBeenCalledWith(null);
  });

  it("gives an https target with a certificate TLS that presents the credential's pair", () => {
    const createSsl = vi.spyOn(credentials, "createSsl");
    const pair = clientCert();

    expect(grpcChannelCredentials(target, pair)._isSecure()).toBe(true);
    expect(createSsl).toHaveBeenCalledWith(null, Buffer.from(pair.key, "utf8"), Buffer.from(pair.cert, "utf8"));
  });

  it("throws when the pair does not load", () => {
    expect(() => grpcChannelCredentials(target, BAD_PAIR)).toThrow();
  });
});

describe("grpcMetadata and metadataEntries", () => {
  it("lowercases names, keeps repeated names in order, and carries a -bin value as bytes and back as base64", () => {
    const bytes = Buffer.from([0, 1, 2, 250, 255]);

    const metadata = grpcMetadata([
      ["X-Trace", "t-1"],
      ["x-trace", "t-2"],
      ["Sig-Bin", bytes.toString("base64")],
    ]);

    expect(metadata.get("x-trace")).toEqual(["t-1", "t-2"]);
    expect(metadata.get("sig-bin")).toEqual([bytes]);
    expect(metadataEntries(metadata)).toEqual([
      ["x-trace", "t-1"],
      ["x-trace", "t-2"],
      ["sig-bin", bytes.toString("base64")],
    ]);
  });

  it("returns no entries for empty metadata", () => {
    expect(metadataEntries(new Metadata())).toEqual([]);
  });

  it("throws for a name grpc-js cannot send", () => {
    expect(() => grpcMetadata([["bad key", "value"]])).toThrow(/bad key/);
  });
});
