// index.test.ts: createUpstreams routes each call to the HTTP or gRPC sender and closes both.
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  Server as GrpcServer,
  ServerCredentials,
  status as grpcStatus,
  type MethodDefinition,
  type ServerWritableStream,
  type ServiceDefinition,
  type UntypedServiceImplementation,
} from "@grpc/grpc-js";
import { afterEach, describe, expect, it } from "vitest";
import { RecordingSink } from "../test/fixtures";
import { createUpstreams } from "./index";
import type { Upstreams } from "./types";

const SERVICE = "a_intel.ledger.v1.Ledger";
const identity = (bytes: Buffer): Buffer => bytes;

const LIST_ENTRIES: MethodDefinition<Buffer, Buffer> = {
  path: `/${SERVICE}/ListEntries`,
  requestStream: false,
  responseStream: true,
  requestSerialize: identity,
  requestDeserialize: identity,
  responseSerialize: identity,
  responseDeserialize: identity,
};

const httpServers: HttpServer[] = [];
const grpcServers: GrpcServer[] = [];
const opened: Upstreams[] = [];

afterEach(async () => {
  for (const upstreams of opened.splice(0)) upstreams.close();
  for (const server of grpcServers.splice(0)) server.forceShutdown();
  await Promise.all(
    httpServers.splice(0).map((server) => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    }),
  );
});

function newUpstreams(maxResponseBytes = 1024 * 1024): Upstreams {
  const upstreams = createUpstreams({ maxResponseBytes });
  opened.push(upstreams);
  return upstreams;
}

/** An HTTP server that answers every request with "ok from http". */
async function startHttpServer(): Promise<number> {
  const server = createServer((_req, res) => res.end("ok from http"));
  httpServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

/** A gRPC server whose ListEntries answers with one message of `size` bytes. */
async function startGrpcServer(size: number): Promise<number> {
  const server = new GrpcServer();
  grpcServers.push(server);
  const definition: ServiceDefinition = { ListEntries: LIST_ENTRIES };
  const implementation: UntypedServiceImplementation = {
    ListEntries: (call: ServerWritableStream<Buffer, Buffer>): void => {
      call.write(Buffer.alloc(size, 7));
      call.end();
    },
  };
  server.addService(definition, implementation);
  return new Promise<number>((resolve, reject) => {
    server.bindAsync("127.0.0.1:0", ServerCredentials.createInsecure(), (error, port) =>
      error === null ? resolve(port) : reject(error),
    );
  });
}

function callHttp(upstreams: Upstreams, port: number): RecordingSink {
  const sink = new RecordingSink();
  upstreams.http({
    target: { kind: "http", scheme: "http", method: "GET", host: "127.0.0.1", port, path: "/" },
    headers: [],
    body: new Uint8Array(),
    deadlineMs: 2_000,
    signal: new AbortController().signal,
    sink,
  });
  return sink;
}

function callGrpc(upstreams: Upstreams, port: number): RecordingSink {
  const sink = new RecordingSink();
  upstreams.grpc({
    target: { kind: "grpc", scheme: "http", host: "127.0.0.1", port, service: SERVICE, method: "ListEntries" },
    headers: [],
    body: Buffer.from("request"),
    deadlineMs: 2_000,
    signal: new AbortController().signal,
    sink,
  });
  return sink;
}

describe("createUpstreams", () => {
  it("sends an http call through the HTTP sender", async () => {
    const port = await startHttpServer();

    const sink = callHttp(newUpstreams(), port);

    expect(await sink.done).toEqual({ kind: "end" });
    expect(sink.body().toString()).toBe("ok from http");
  });

  it("sends a grpc call through the gRPC sender", async () => {
    const port = await startGrpcServer(16);

    const sink = callGrpc(newUpstreams(), port);

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });
    expect(sink.body().equals(Buffer.alloc(16, 7))).toBe(true);
  });

  it("gives the gRPC sender its maxResponseBytes", async () => {
    const port = await startGrpcServer(2048);

    const sink = callGrpc(newUpstreams(1024), port);

    expect(await sink.done).toMatchObject({ kind: "trailers", code: grpcStatus.RESOURCE_EXHAUSTED });
  });

  it("closes both senders without throwing when idle", () => {
    const upstreams = createUpstreams({ maxResponseBytes: 1024 });

    expect(() => upstreams.close()).not.toThrow();
  });

  it("closes both senders without throwing after an http and a grpc call", async () => {
    const httpPort = await startHttpServer();
    const grpcPort = await startGrpcServer(16);
    const upstreams = createUpstreams({ maxResponseBytes: 1024 });

    const http = callHttp(upstreams, httpPort);
    const grpc = callGrpc(upstreams, grpcPort);
    expect(await http.done).toEqual({ kind: "end" });
    expect(await grpc.done).toMatchObject({ kind: "trailers", code: grpcStatus.OK });

    expect(() => upstreams.close()).not.toThrow();
  });
});
