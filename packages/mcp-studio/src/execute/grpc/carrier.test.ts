// carrier.ts: gRPC calls over HTTP/2 to an in-process ledger server, in
// cleartext and with TLS.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonValue } from "@bufbuild/protobuf";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TransportError,
  type GrpcTarget,
  type GrpcTransportRequest,
  type GrpcTransportResponse,
  type Transport,
} from "../transport";
import { createGrpcCarrier, dialAddress } from "./carrier";
import { decodeResponse, encodeRequest, resolveMethod, type ResolvedMethod } from "./descriptors";
import { GET_ENTRY, LIST_ENTRIES } from "./__tests__/ledger-context";
import { LEDGER_DESCRIPTOR_SET } from "./__tests__/ledger-descriptor-set";
import { entry, GrpcFailure, startLedgerServer, type LedgerServer } from "./__tests__/ledger-server";

const getEntry = resolveMethod(LEDGER_DESCRIPTOR_SET, GET_ENTRY);
const listEntries = resolveMethod(LEDGER_DESCRIPTOR_SET, LIST_ENTRIES);

function target(port: number, method: string, fields: Partial<GrpcTarget> = {}): GrpcTarget {
  return {
    kind: "grpc",
    scheme: "http",
    host: "127.0.0.1",
    port,
    service: "a_intel.ledger.v1.Ledger",
    method,
    ...fields,
  };
}

function call(to: GrpcTarget, message: Uint8Array, fields: Partial<GrpcTransportRequest> = {}): GrpcTransportRequest {
  return {
    network: "cloud",
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    target: to,
    metadata: [],
    message,
    ...fields,
  };
}

async function decodeAll(method: ResolvedMethod, response: GrpcTransportResponse): Promise<JsonValue[]> {
  const items: JsonValue[] = [];
  for await (const message of response.messages) items.push(decodeResponse(method, message));
  return items;
}

const idsOf = (items: JsonValue[]): unknown[] =>
  items.map((item) => (item !== null && typeof item === "object" && !Array.isArray(item) ? item.id : undefined));

function transportError(promise: Promise<unknown>): Promise<TransportError> {
  return promise.then(
    () => {
      throw new Error("The carrier did not refuse the call.");
    },
    (error: unknown) => {
      if (error instanceof TransportError) return error;
      throw error;
    },
  );
}

describe("createGrpcCarrier over cleartext HTTP/2", () => {
  let server: LedgerServer;
  const carrier = createGrpcCarrier();

  beforeAll(async () => {
    server = await startLedgerServer();
  });

  afterAll(() => server.close());

  it("carries a unary call with its metadata and returns the status", async () => {
    server.handlers.GetEntry = (request) => entry(String(request.id));
    const response = await carrier.grpc(
      call(target(server.port, "GetEntry"), encodeRequest(getEntry, { id: "e_1" }), {
        metadata: [["authorization", "Bearer tok_1"]],
      }),
    );
    expect(idsOf(await decodeAll(getEntry, response))).toEqual(["e_1"]);
    expect((await response.status()).code).toBe(0);
    const [received] = server.callsTo("GetEntry").slice(-1);
    expect(received?.request).toEqual({ id: "e_1" });
    expect(received?.metadata.authorization).toEqual(["Bearer tok_1"]);
    expect(received?.host).toBe(`127.0.0.1:${server.port}`);
  });

  it("reads a server stream in order", async () => {
    server.handlers.ListEntries = (_, context) => {
      for (const id of ["e_1", "e_2", "e_3"]) context.write(entry(id));
    };
    const response = await carrier.grpc(
      call(target(server.port, "ListEntries"), encodeRequest(listEntries, { accountId: "acct_1" })),
    );
    expect(idsOf(await decodeAll(listEntries, response))).toEqual(["e_1", "e_2", "e_3"]);
    expect((await response.status()).code).toBe(0);
  });

  it("keeps every message when the reader falls behind the stream", async () => {
    const ids = Array.from({ length: 50 }, (_, index) => `e_${index}`);
    server.handlers.ListEntries = (_, context) => {
      for (const id of ids) context.write(entry(id));
    };
    const response = await carrier.grpc(
      call(target(server.port, "ListEntries"), encodeRequest(listEntries, { accountId: "acct_1" })),
    );
    // Let the queue pass its high-water mark before the first read.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(idsOf(await decodeAll(listEntries, response))).toEqual(ids);
    expect((await response.status()).code).toBe(0);
  });

  it("returns the code, message, and trailers of a failed call", async () => {
    server.handlers.GetEntry = () => {
      throw new GrpcFailure(5, "No entry e_9.", { "x-trace-id": "t_1", "x-detail-bin": Buffer.from([1, 2, 3]) });
    };
    const response = await carrier.grpc(call(target(server.port, "GetEntry"), encodeRequest(getEntry, { id: "e_9" })));
    expect(await decodeAll(getEntry, response)).toEqual([]);
    const status = await response.status();
    expect(status.code).toBe(5);
    expect(status.message).toBe("No entry e_9.");
    expect(status.metadata).toEqual(
      expect.arrayContaining([
        ["x-trace-id", "t_1"],
        ["x-detail-bin", "AQID"],
      ]),
    );
  });

  it("cancels the call when the signal aborts", async () => {
    let upstreamCancelled = false;
    server.handlers.ListEntries = async (_, context) => {
      context.write(entry("e_1"));
      await context.cancelled;
      upstreamCancelled = true;
    };
    const controller = new AbortController();
    const response = await carrier.grpc(
      call(target(server.port, "ListEntries"), encodeRequest(listEntries, {}), { signal: controller.signal }),
    );
    const read: string[] = [];
    for await (const message of response.messages) {
      read.push(String(idsOf([decodeResponse(listEntries, message)])[0]));
      controller.abort();
    }
    expect(read).toEqual(["e_1"]);
    expect((await response.status()).code).toBe(1);
    await vi.waitFor(() => expect(upstreamCancelled).toBe(true));
  });

  it("sends the deadline with the call", async () => {
    server.handlers.GetEntry = async (_, context) => {
      await context.cancelled;
      return entry("e_1");
    };
    const response = await carrier.grpc(
      call(target(server.port, "GetEntry"), encodeRequest(getEntry, { id: "e_1" }), { deadline_ms: 200 }),
    );
    expect(await decodeAll(getEntry, response)).toEqual([]);
    expect((await response.status()).code).toBe(4);
  });

  it("refuses a call whose signal aborted before it was sent", async () => {
    const before = server.calls.length;
    const controller = new AbortController();
    controller.abort();
    const error = await transportError(
      carrier.grpc(call(target(server.port, "GetEntry"), encodeRequest(getEntry, {}), { signal: controller.signal })),
    );
    expect(error.code).toBe("not_sent");
    expect(error.message).toBe("The call was cancelled before it was sent.");
    expect(server.calls.length).toBe(before);
  });

  it("refuses metadata gRPC cannot carry", async () => {
    const error = await transportError(
      carrier.grpc(call(target(server.port, "GetEntry"), encodeRequest(getEntry, {}), { metadata: [["X Key", "1"]] })),
    );
    expect(error.code).toBe("not_sent");
    expect(error.message).toMatch(/^The call metadata is not valid: /);
  });

  it("refuses a call for a network other than cloud", async () => {
    const error = await transportError(
      carrier.grpc(call(target(server.port, "GetEntry"), encodeRequest(getEntry, {}), { network: "relay:acme" })),
    );
    expect(error.code).toBe("unsupported");
    expect(error.message).toBe("The gRPC carrier sends on the cloud network only, and this call is for relay:acme.");
  });

  it("refuses HTTP and local calls", async () => {
    const http = await transportError(carrier.http({} as Parameters<Transport["http"]>[0]));
    const local = await transportError(carrier.local({} as Parameters<Transport["local"]>[0]));
    for (const error of [http, local]) {
      expect(error.code).toBe("unsupported");
      expect(error.message).toBe("The gRPC carrier sends gRPC calls only.");
      expect(error.sent).toBe(false);
    }
  });
});

describe("createGrpcCarrier with a resolve hook", () => {
  let server: LedgerServer;

  beforeAll(async () => {
    server = await startLedgerServer();
    server.handlers.GetEntry = (request) => entry(String(request.id));
  });

  afterAll(() => server.close());

  it("dials the address the hook returns and names the host in :authority", async () => {
    const asked: string[] = [];
    const carrier = createGrpcCarrier({
      resolve: (host) => {
        asked.push(host);
        return Promise.resolve("127.0.0.1");
      },
    });
    const response = await carrier.grpc(
      call(target(server.port, "GetEntry", { host: "ledger.test" }), encodeRequest(getEntry, { id: "e_1" })),
    );
    expect(idsOf(await decodeAll(getEntry, response))).toEqual(["e_1"]);
    expect(asked).toEqual(["ledger.test"]);
    expect(server.callsTo("GetEntry").at(-1)?.host).toBe(`ledger.test:${server.port}`);
  });

  it("passes the hook's refusal through", async () => {
    const refusal = new TransportError("refused_address", "10.0.0.5 is a private address.", false);
    const carrier = createGrpcCarrier({ resolve: () => Promise.reject(refusal) });
    const error = await transportError(
      carrier.grpc(call(target(server.port, "GetEntry", { host: "ledger.test" }), encodeRequest(getEntry, {}))),
    );
    expect(error).toBe(refusal);
  });

  it("reports a host that did not resolve as not sent", async () => {
    const carrier = createGrpcCarrier({ resolve: () => Promise.reject(new Error("ENOTFOUND")) });
    const error = await transportError(
      carrier.grpc(call(target(server.port, "GetEntry", { host: "ledger.test" }), encodeRequest(getEntry, {}))),
    );
    expect(error.code).toBe("not_sent");
    expect(error.message).toBe("ledger.test did not resolve: ENOTFOUND");
  });

  it("sends nothing when the signal aborts while the host resolves", async () => {
    const controller = new AbortController();
    const carrier = createGrpcCarrier({
      resolve: () => {
        controller.abort();
        return Promise.resolve("127.0.0.1");
      },
    });
    const error = await transportError(
      carrier.grpc(
        call(target(server.port, "GetEntry", { host: "ledger.test" }), encodeRequest(getEntry, {}), {
          signal: controller.signal,
        }),
      ),
    );
    expect(error.code).toBe("not_sent");
  });
});

describe("createGrpcCarrier over TLS", () => {
  let server: LedgerServer;
  let cert: Buffer;
  let folder: string;

  beforeAll(async () => {
    // A certificate for localhost alone, with no IP address in it, so a
    // call that dials 127.0.0.1 passes only when TLS checks the host name.
    folder = mkdtempSync(join(tmpdir(), "m7-grpc-tls-"));
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
        "-keyout",
        join(folder, "key.pem"),
        "-out",
        join(folder, "cert.pem"),
      ],
      { encoding: "utf8" },
    );
    if (made.status !== 0) {
      throw new Error(`openssl did not make the test certificate: ${made.error?.message ?? made.stderr}`);
    }
    cert = readFileSync(join(folder, "cert.pem"));
    server = await startLedgerServer({ tls: { key: readFileSync(join(folder, "key.pem")), cert } });
    server.handlers.GetEntry = (request) => entry(String(request.id));
  });

  afterAll(() => {
    server.close();
    rmSync(folder, { recursive: true, force: true });
  });

  const tlsTarget = (): GrpcTarget => target(server.port, "GetEntry", { scheme: "https", host: "localhost" });

  it("checks the certificate against the host name, not the dialed address", async () => {
    const carrier = createGrpcCarrier({ root_certs: cert, resolve: () => Promise.resolve("127.0.0.1") });
    const response = await carrier.grpc(call(tlsTarget(), encodeRequest(getEntry, { id: "e_1" })));
    expect(idsOf(await decodeAll(getEntry, response))).toEqual(["e_1"]);
    expect((await response.status()).code).toBe(0);
  });

  it("fails a certificate the roots do not trust", async () => {
    const carrier = createGrpcCarrier({ resolve: () => Promise.resolve("127.0.0.1") });
    const response = await carrier.grpc(call(tlsTarget(), encodeRequest(getEntry, { id: "e_1" })));
    expect(await decodeAll(getEntry, response)).toEqual([]);
    expect((await response.status()).code).toBe(14);
  });
});

describe("dialAddress", () => {
  const ledger = (fields: Partial<GrpcTarget>): GrpcTarget => ({
    kind: "grpc",
    scheme: "https",
    host: "ledger.example.com",
    service: "a_intel.ledger.v1.Ledger",
    method: "GetEntry",
    ...fields,
  });

  it("dials the host by name on the scheme's default port", () => {
    expect(dialAddress(ledger({}), undefined)).toBe("dns:ledger.example.com:443");
    expect(dialAddress(ledger({ scheme: "http" }), undefined)).toBe("dns:ledger.example.com:80");
  });

  it("dials a pinned IPv4 or IPv6 address", () => {
    expect(dialAddress(ledger({ port: 8443 }), "10.0.0.5")).toBe("ipv4:10.0.0.5:8443");
    expect(dialAddress(ledger({}), "2001:db8::1")).toBe("ipv6:[2001:db8::1]:443");
  });
});
