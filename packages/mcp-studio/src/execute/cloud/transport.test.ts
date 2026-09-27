import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  TransportError,
  type GrpcTransportRequest,
  type HttpTarget,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type LocalCall,
} from "../transport";
import { createCloudTransport, pinnedLookup } from "./transport";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Received {
  method: string | undefined;
  url: string | undefined;
  host: string | undefined;
  headers: Array<[string, string]>;
  body: string;
}

interface Upstream {
  port: number;
  /** Each request the upstream read to its end, in order. */
  received: Received[];
  /** How many connections the upstream accepted. */
  connections: number;
  close(): Promise<void>;
}

const open: Upstream[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((upstream) => upstream.close()));
});

function pairs(raw: readonly string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let index = 0; index + 1 < raw.length; index += 2) out.push(raw.slice(index, index + 2) as [string, string]);
  return out;
}

/** A loopback upstream. It reads each request to its end, records it, and then calls the handler. */
async function startUpstream(handle: Handler, tls?: { key: Buffer; cert: Buffer }): Promise<Upstream> {
  const received: Received[] = [];
  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        method: request.method,
        url: request.url,
        host: request.headers.host,
        headers: pairs(request.rawHeaders),
        body: Buffer.concat(chunks).toString("utf8"),
      });
      handle(request, response);
    });
  };
  const server: Server & { closeAllConnections(): void } =
    tls === undefined ? createServer(onRequest) : createTlsServer(tls, onRequest);
  const upstream: Upstream = {
    port: 0,
    received,
    connections: 0,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  server.on("connection", () => {
    upstream.connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  upstream.port = (server.address() as AddressInfo).port;
  open.push(upstream);
  return upstream;
}

/** The injected resolve: every host is the loopback upstream. The default guard would refuse it. */
const loopback = (): Promise<string> => Promise.resolve("127.0.0.1");

function request(target: Partial<HttpTarget>, fields: Partial<HttpTransportRequest> = {}): HttpTransportRequest {
  return {
    network: "cloud",
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    // The name does not resolve, so a request that reaches the upstream
    // proves the transport dialed the address it checked.
    target: { kind: "http", scheme: "http", method: "GET", host: "upstream.invalid", port: 1, path: "/v1/items", ...target },
    headers: [],
    body: new Uint8Array(),
    ...fields,
  };
}

async function readText(response: HttpTransportResponse): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function failureOf(pending: Promise<unknown>): Promise<Error> {
  const outcome = await pending.then(
    () => undefined,
    (error: unknown) => error,
  );
  if (!(outcome instanceof Error)) throw new Error("The call did not fail.");
  return outcome;
}

describe("createCloudTransport over HTTP", () => {
  it("dials the checked address, names the host, and returns the response as it arrived", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.setHeader("X-Tag", ["a", "b"]);
      response.end('{"ok":true}');
    });
    const asked: string[] = [];
    const transport = createCloudTransport({
      resolve: (host) => {
        asked.push(host);
        return Promise.resolve("127.0.0.1");
      },
    });

    const response = await transport.http(
      request(
        { method: "POST", port: upstream.port, path: "/v1/items?limit=2" },
        {
          headers: [
            ["Content-Type", "application/json"],
            ["x-trace", "one"],
            ["X-Trace", "two"],
          ],
          body: new TextEncoder().encode('{"name":"a"}'),
        },
      ),
    );

    expect(response.status).toBe(200);
    expect(response.headers.filter(([name]) => name === "X-Tag")).toEqual([
      ["X-Tag", "a"],
      ["X-Tag", "b"],
    ]);
    expect(await readText(response)).toBe('{"ok":true}');
    expect(asked).toEqual(["upstream.invalid"]);
    expect(upstream.received).toHaveLength(1);
    expect(upstream.received[0]).toMatchObject({
      method: "POST",
      url: "/v1/items?limit=2",
      host: `upstream.invalid:${upstream.port}`,
      body: '{"name":"a"}',
    });
    expect(upstream.received[0]?.headers.filter(([name]) => name === "x-trace")).toEqual([
      ["x-trace", "one"],
      ["x-trace", "two"],
    ]);
  });

  it("returns a redirect to the caller and does not follow it", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      response.end();
    });
    const response = await createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }));
    expect(response.status).toBe(302);
    expect(response.headers).toContainEqual(["Location", "http://169.254.169.254/latest/meta-data/"]);
    await readText(response);
    expect(upstream.received).toHaveLength(1);
  });

  it("reuses a kept-alive connection for the next call", async () => {
    const upstream = await startUpstream((_request, response) => response.end("ok"));
    const transport = createCloudTransport({ resolve: loopback });

    expect(await readText(await transport.http(request({ port: upstream.port })))).toBe("ok");
    await new Promise((resolve) => setImmediate(resolve));
    expect(await readText(await transport.http(request({ port: upstream.port })))).toBe("ok");

    expect(upstream.received).toHaveLength(2);
    expect(upstream.connections).toBe(1);
  });

  it("reports a refused connection as not sent", async () => {
    const upstream = await startUpstream((_request, response) => response.end());
    await upstream.close();
    await expect(createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }))).rejects.toMatchObject({
      name: "TransportError",
      code: "not_sent",
      sent: false,
      message: expect.stringMatching(/^The connection to upstream\.invalid failed: /),
    });
  });

  it("reports a connection dropped after the send as one the upstream may have received", async () => {
    const upstream = await startUpstream((request) => request.socket.destroy());
    const failure = await failureOf(createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port })));
    expect(failure).not.toBeInstanceOf(TransportError);
    expect(failure.message).toMatch(/^The connection to upstream\.invalid failed after the request was sent: /);
  });

  it("reports a body cut short as an error, not a short body", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("partial", () => setTimeout(() => response.destroy(), 20));
    });
    const response = await createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }));
    expect(response.status).toBe(200);
    const failure = await failureOf(readText(response));
    expect(failure).not.toBeInstanceOf(TransportError);
    expect(failure.message).toMatch(/^The connection to upstream\.invalid closed before the response ended: /);
  });

  it("stops at the deadline while it waits for the response", async () => {
    const upstream = await startUpstream(() => undefined);
    await expect(
      createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }, { deadline_ms: 100 })),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "timeout",
      sent: true,
      message: "The call passed its 100 ms deadline.",
    });
  });

  it("stops at the deadline while the body arrives", async () => {
    const upstream = await startUpstream((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("first");
    });
    const response = await createCloudTransport({ resolve: loopback }).http(
      request({ port: upstream.port }, { deadline_ms: 200 }),
    );
    await expect(readText(response)).rejects.toMatchObject({
      name: "TransportError",
      code: "timeout",
      sent: true,
      message: "The call passed its 200 ms deadline.",
    });
  });

  it("stops at the deadline before the send when the lookup does not answer", async () => {
    const transport = createCloudTransport({ resolve: () => new Promise<string>(() => undefined) });
    await expect(transport.http(request({}, { deadline_ms: 50 }))).rejects.toMatchObject({
      name: "TransportError",
      code: "timeout",
      sent: false,
      message: "The call passed its 50 ms deadline before it was sent.",
    });
  });

  it("reports a failed lookup as not sent", async () => {
    const transport = createCloudTransport({ resolve: () => Promise.reject(new Error("resolver offline")) });
    await expect(transport.http(request({}))).rejects.toMatchObject({
      name: "TransportError",
      code: "not_sent",
      sent: false,
      message: "upstream.invalid did not resolve: resolver offline",
    });
  });

  it("refuses a call cancelled before it starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const resolve = vi.fn(loopback);
    await expect(
      createCloudTransport({ resolve }).http(request({}, { signal: controller.signal })),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "not_sent",
      sent: false,
      message: "The call was cancelled before it was sent.",
    });
  });

  it("reports a cancel after the send as a call the upstream may have received", async () => {
    let arrive: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    const upstream = await startUpstream(() => arrive());
    const controller = new AbortController();
    const pending = failureOf(
      createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }, { signal: controller.signal })),
    );
    await arrived;
    controller.abort();
    const failure = await pending;
    expect(failure).not.toBeInstanceOf(TransportError);
    expect(failure.message).toBe("The call was cancelled after it was sent.");
  });

  it("closes the connection when the caller cancels the response", async () => {
    let closed: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const upstream = await startUpstream((_request, response) => {
      response.on("close", () => closed());
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.write("first");
    });
    const response = await createCloudTransport({ resolve: loopback }).http(request({ port: upstream.port }));
    response.cancel();
    await done;
  });

  it("refuses a header Node cannot send, and does not quote its value", async () => {
    const failure = await failureOf(
      createCloudTransport({ resolve: loopback }).http(request({}, { headers: [["X-Token", "secret\nvalue"]] })),
    );
    expect(failure).toMatchObject({ name: "TransportError", code: "not_sent", sent: false });
    expect(failure.message).toMatch(/^The request is not valid: /);
    expect(failure.message).not.toContain("secret");
  });
});

describe("createCloudTransport over TLS", () => {
  let folder: string;
  let key: Buffer;
  let cert: Buffer;

  beforeAll(() => {
    // A certificate for localhost alone, with no IP address in it, so a
    // call that dials 127.0.0.1 passes only when TLS checks the host name.
    folder = mkdtempSync(join(tmpdir(), "m6-cloud-tls-"));
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
    key = readFileSync(join(folder, "key.pem"));
    cert = readFileSync(join(folder, "cert.pem"));
  });

  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it("checks the certificate against the host name, not the dialed address", async () => {
    const upstream = await startUpstream((_request, response) => response.end("secure"), { key, cert });
    const transport = createCloudTransport({ resolve: loopback, root_certs: cert });
    const response = await transport.http(request({ scheme: "https", host: "localhost", port: upstream.port }));
    expect(response.status).toBe(200);
    expect(await readText(response)).toBe("secure");
    expect(upstream.received[0]?.host).toBe(`localhost:${upstream.port}`);
  });

  it("refuses a certificate the roots do not trust, before the send", async () => {
    const upstream = await startUpstream((_request, response) => response.end("secure"), { key, cert });
    const transport = createCloudTransport({ resolve: loopback });
    await expect(
      transport.http(request({ scheme: "https", host: "localhost", port: upstream.port })),
    ).rejects.toMatchObject({
      name: "TransportError",
      code: "not_sent",
      sent: false,
      message: expect.stringMatching(/^The connection to localhost failed: /),
    });
    expect(upstream.received).toHaveLength(0);
  });
});

describe("createCloudTransport address guard", () => {
  const REFUSAL_TAIL = ", and the cloud network sends only to public addresses. Reach a private host through a relay.";

  it.each([
    ["127.0.0.1", "127.0.0.1 is a loopback address"],
    ["169.254.169.254", "169.254.169.254 is a link-local address"],
    ["10.0.0.8", "10.0.0.8 is a private address"],
  ])("refuses the HTTP host %s before it connects", async (host, start) => {
    await expect(createCloudTransport().http(request({ host, port: 8080 }))).rejects.toMatchObject({
      name: "TransportError",
      code: "refused_address",
      sent: false,
      message: `${start}${REFUSAL_TAIL}`,
    });
  });

  it("refuses a host name that resolves to a loopback address", async () => {
    await expect(createCloudTransport().http(request({ host: "localhost", port: 8080 }))).rejects.toMatchObject({
      code: "refused_address",
      sent: false,
      message: expect.stringMatching(/^localhost resolves to \S+, a loopback address, and the cloud network/),
    });
  });

  it("refuses a gRPC call to a private address", async () => {
    const call: GrpcTransportRequest = {
      network: "cloud",
      deadline_ms: 5_000,
      signal: new AbortController().signal,
      relay_credential: undefined,
      target: {
        kind: "grpc",
        scheme: "http",
        host: "10.0.0.8",
        port: 50051,
        service: "a_intel.ledger.v1.Ledger",
        method: "GetEntry",
      },
      metadata: [],
      message: new Uint8Array(),
    };
    await expect(createCloudTransport().grpc(call)).rejects.toMatchObject({
      code: "refused_address",
      sent: false,
      message: `10.0.0.8 is a private address${REFUSAL_TAIL}`,
    });
  });
});

describe("createCloudTransport routes", () => {
  it("refuses a call for a relay network", async () => {
    await expect(createCloudTransport().http(request({}, { network: "relay:office" }))).rejects.toMatchObject({
      name: "TransportError",
      code: "unsupported",
      sent: false,
      message: "The cloud Transport sends on the cloud network only, and this call is for relay:office.",
    });
  });

  it("refuses a call that carries a relay credential", async () => {
    await expect(
      createCloudTransport().http(request({}, { relay_credential: { name: "billing-token", scheme: "bearer" } })),
    ).rejects.toMatchObject({
      code: "unsupported",
      sent: false,
      message: "The cloud Transport cannot add a relay credential. Only a relay adds one.",
    });
  });

  it("refuses a gRPC call for a relay network", async () => {
    const call: GrpcTransportRequest = {
      network: "relay:office",
      deadline_ms: 5_000,
      signal: new AbortController().signal,
      relay_credential: undefined,
      target: { kind: "grpc", scheme: "https", host: "ledger.internal", service: "a_intel.ledger.v1.Ledger", method: "GetEntry" },
      metadata: [],
      message: new Uint8Array(),
    };
    await expect(createCloudTransport().grpc(call)).rejects.toMatchObject({
      code: "unsupported",
      message: "The cloud Transport sends on the cloud network only, and this call is for relay:office.",
    });
  });

  it("refuses a local server's call", async () => {
    const call: LocalCall = {
      tool: "files__read_file",
      upstream: "read_file",
      version: 1,
      definition_hash: "sha256:0000",
      package_digest: "sha256:1111",
      arguments: { path: "README.md" },
      deadline_ms: 5_000,
      signal: new AbortController().signal,
    };
    await expect(createCloudTransport().local(call)).rejects.toMatchObject({
      name: "TransportError",
      code: "unsupported",
      sent: false,
      message: "The cloud Transport does not reach local servers. A local server's calls go through the local gateway.",
    });
  });
});

describe("pinnedLookup", () => {
  it("answers every lookup with the address it was given", () => {
    const all = vi.fn();
    pinnedLookup("93.184.216.34")("anything.example.com", { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);

    const one = vi.fn();
    pinnedLookup("93.184.216.34")("anything.example.com", {}, one);
    expect(one).toHaveBeenCalledWith(null, "93.184.216.34", 4);

    const six = vi.fn();
    pinnedLookup("2606:4700:4700::1111")("anything.example.com", {}, six);
    expect(six).toHaveBeenCalledWith(null, "2606:4700:4700::1111", 6);
  });
});
