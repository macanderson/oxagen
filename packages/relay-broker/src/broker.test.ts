// broker.ts over loopback: a real HTTP server on 127.0.0.1 mounts the broker,
// and a fake relay connects to it with the ws client.
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  documentHash,
  envelopeSigningBytes,
  relayEnvelopeSchema,
  relayHeadersHash,
  TransportError,
  type GrpcTarget,
  type GrpcTransportRequest,
  type HttpTarget,
  type HttpTransportRequest,
  type RelayEnvelope,
} from "@oxagen/mcp-studio";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import {
  createRelayBroker,
  DEFAULT_ENVELOPE_TTL_MS,
  type RelayBroker,
  type RelayBrokerOptions,
  type RelayScope,
  type RelayStatusEvent,
} from "./broker";
import {
  CLOSE_HELLO_MISMATCH,
  CLOSE_NO_HELLO,
  decodeBrokerFrame,
  encodeFrame,
  fromBase64,
  MAX_REQUEST_BODY_BYTES,
  RELAY_CONNECT_PATH,
  RELAY_PROTOCOL_VERSION,
  toBase64,
  type BrokerFrame,
  type RelayFrame,
} from "./protocol/frames";
import { relaySignerFromPem, type RelaySigner } from "./signer";
import { generateRelayToken, hashRelayToken, memoryRelayTokenVerifier, type RelayIdentity } from "./tokens";

const WORKSPACE = "wrk_0123456789abcdefghjkmn";

const identity: RelayIdentity = { orgId: "org-1", workspaceId: "ws-1", workspacePublicId: WORKSPACE, relay: "office" };

const scope: RelayScope = { orgId: "org-1", workspaceId: "ws-1", workspacePublicId: WORKSPACE, planTier: "enterprise" };

const httpTarget: HttpTarget = {
  kind: "http",
  scheme: "https",
  method: "POST",
  host: "billing.internal",
  path: "/v1/invoices?limit=5",
};

const grpcTarget: GrpcTarget = {
  kind: "grpc",
  scheme: "http",
  host: "ledger.internal",
  port: 50051,
  service: "ledger.v1.Ledger",
  method: "GetBalance",
};

const encoder = new TextEncoder();

function httpRequest(overrides: Partial<HttpTransportRequest> = {}): HttpTransportRequest {
  return {
    network: "relay:office",
    target: httpTarget,
    headers: [
      ["Content-Type", "application/json"],
      ["accept", "application/json"],
    ],
    body: encoder.encode('{"customer":"c-9"}'),
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    ...overrides,
  };
}

function grpcRequest(overrides: Partial<GrpcTransportRequest> = {}): GrpcTransportRequest {
  return {
    network: "relay:office",
    target: grpcTarget,
    metadata: [["x-trace-id", "t-1"]],
    message: new Uint8Array([10, 3, 97, 99, 99]),
    deadline_ms: 5_000,
    signal: new AbortController().signal,
    relay_credential: undefined,
    ...overrides,
  };
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function readText(parts: AsyncIterable<Uint8Array>): Promise<string> {
  const buffers: Buffer[] = [];
  for await (const part of parts) buffers.push(Buffer.from(part));
  return Buffer.concat(buffers).toString("utf8");
}

interface Closed {
  code: number;
  reason: string;
}

/** A relay that speaks the frames by hand, so a test controls every reply. */
class FakeRelay {
  private readonly inbox: BrokerFrame[] = [];
  private readonly waiting: { type: BrokerFrame["type"]; resolve: (frame: BrokerFrame) => void }[] = [];
  readonly closed: Promise<Closed>;

  private constructor(readonly socket: WebSocket) {
    socket.on("message", (data) => {
      const frame = decodeBrokerFrame(rawText(data));
      if (!frame) throw new Error(`The broker sent an unreadable frame: ${rawText(data)}`);
      const index = this.waiting.findIndex((waiter) => waiter.type === frame.type);
      const waiter = index === -1 ? undefined : this.waiting.splice(index, 1)[0];
      if (waiter) waiter.resolve(frame);
      else this.inbox.push(frame);
    });
    this.closed = new Promise((resolve) => {
      socket.on("close", (code, reason) => resolve({ code, reason: reason.toString("utf8") }));
    });
  }

  static open(url: string, token: string): Promise<FakeRelay> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
      socket.once("open", () => resolve(new FakeRelay(socket)));
      socket.once("error", reject);
    });
  }

  /** Open, say hello, and wait for the welcome. */
  static async connect(url: string, token: string): Promise<FakeRelay> {
    const relay = await FakeRelay.open(url, token);
    relay.hello();
    await relay.next("welcome");
    return relay;
  }

  hello(overrides: Partial<Extract<RelayFrame, { type: "hello" }>> = {}): void {
    this.send({
      type: "hello",
      protocol: RELAY_PROTOCOL_VERSION,
      relay: identity.relay,
      workspace: WORKSPACE,
      version: "test",
      ...overrides,
    });
  }

  send(frame: RelayFrame): void {
    this.socket.send(encodeFrame(frame));
  }

  sendRaw(text: string | Buffer): void {
    this.socket.send(text);
  }

  next<T extends BrokerFrame["type"]>(type: T): Promise<Extract<BrokerFrame, { type: T }>> {
    const index = this.inbox.findIndex((frame) => frame.type === type);
    const queued = index === -1 ? undefined : this.inbox.splice(index, 1)[0];
    if (queued) return Promise.resolve(queued as Extract<BrokerFrame, { type: T }>);
    return new Promise((resolve) => {
      this.waiting.push({ type, resolve: resolve as (frame: BrokerFrame) => void });
    });
  }

  /** The frames the broker sent that no test has read yet. */
  unread(): readonly BrokerFrame[] {
    return this.inbox;
  }

  terminate(): void {
    this.socket.terminate();
  }
}

interface Harness {
  broker: RelayBroker;
  signer: RelaySigner;
  token: string;
  url: string;
  statuses: RelayStatusEvent[];
}

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startBroker(options: Partial<RelayBrokerOptions> = {}): Promise<Harness> {
  const token = generateRelayToken();
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const signer = relaySignerFromPem(pem);
  const statuses: RelayStatusEvent[] = [];
  const broker = createRelayBroker({
    verifier: memoryRelayTokenVerifier([{ ...identity, tokenHash: hashRelayToken(token) }]),
    signer,
    credentialEntitled: () => Promise.resolve(true),
    onStatus: (event) => statuses.push(event),
    ...options,
  });
  const server: Server = createServer((_request, response) => {
    response.statusCode = 404;
    response.end();
  });
  server.on("upgrade", (request, socket, head) => {
    void broker.handleUpgrade(request, socket, head);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(async () => {
    await broker.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { broker, signer, token, url: `ws://127.0.0.1:${port}${RELAY_CONNECT_PATH}`, statuses };
}

/** The HTTP status the broker answers an upgrade with, or "open" when it accepts it. */
function upgradeOutcome(url: string, headers: Record<string, string>): Promise<number | "open"> {
  return new Promise((resolve) => {
    const socket = new WebSocket(url, { headers });
    socket.on("unexpected-response", (request, response) => {
      resolve(response.statusCode ?? 0);
      response.resume();
      request.destroy();
    });
    socket.on("open", () => {
      resolve("open");
      socket.terminate();
    });
    socket.on("error", () => undefined);
  });
}

function signatureValid(envelope: RelayEnvelope, signer: RelaySigner): boolean {
  return verify(
    null,
    envelopeSigningBytes(envelope),
    createPublicKey(signer.publicKeyPem),
    Buffer.from(envelope.signature.sig, "base64"),
  );
}

describe("the upgrade", () => {
  it("answers 401 with no token and with a token no record holds", async () => {
    const h = await startBroker();
    await expect(upgradeOutcome(h.url, {})).resolves.toBe(401);
    await expect(upgradeOutcome(h.url, { authorization: `Bearer ${generateRelayToken()}` })).resolves.toBe(401);
    await expect(upgradeOutcome(h.url, { authorization: h.token })).resolves.toBe(401);
  });

  it("answers 503 when the token check itself fails", async () => {
    const h = await startBroker({ verifier: { verify: () => Promise.reject(new Error("database down")) } });
    await expect(upgradeOutcome(h.url, { authorization: `Bearer ${h.token}` })).resolves.toBe(503);
  });

  it("accepts a stored token", async () => {
    const h = await startBroker();
    await expect(upgradeOutcome(h.url, { authorization: `Bearer ${h.token}` })).resolves.toBe("open");
  });
});

describe("the hello", () => {
  it("is answered with a welcome that carries the heartbeat interval, and marks the relay up", async () => {
    const h = await startBroker({ heartbeatIntervalMs: 15_000 });
    const relay = await FakeRelay.open(h.url, h.token);
    expect(h.broker.status(scope, "office")).toBe("down");
    relay.hello();
    await expect(relay.next("welcome")).resolves.toStrictEqual({
      type: "welcome",
      protocol: RELAY_PROTOCOL_VERSION,
      heartbeat_ms: 15_000,
    });
    expect(h.broker.status(scope, "office")).toBe("up");
    expect(h.statuses).toMatchObject([{ orgId: "org-1", workspaceId: "ws-1", relay: "office", status: "up" }]);
    relay.terminate();
  });

  it("closes with 4003 when the hello names another workspace", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.open(h.url, h.token);
    relay.hello({ workspace: "wrk_zzzzzzzzzzzzzzzzzzzzzz" });
    await expect(relay.closed).resolves.toMatchObject({ code: CLOSE_HELLO_MISMATCH });
    expect(h.broker.status(scope, "office")).toBe("down");
  });

  it("closes with 4003 when the hello names another relay", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.open(h.url, h.token);
    relay.hello({ relay: "warehouse" });
    await expect(relay.closed).resolves.toMatchObject({ code: CLOSE_HELLO_MISMATCH });
  });

  it("closes with 4008 when no hello arrives within one heartbeat interval", async () => {
    const h = await startBroker({ heartbeatIntervalMs: 100 });
    const relay = await FakeRelay.open(h.url, h.token);
    await expect(relay.closed).resolves.toMatchObject({ code: CLOSE_NO_HELLO });
    expect(h.statuses).toStrictEqual([]);
  });

  it.each([
    ["a heartbeat before the hello", encodeFrame({ type: "hb" })],
    ["text that is not a frame", "{not json"],
    ["a binary message", Buffer.from([1, 2, 3])],
  ])("closes with 1002 on %s", async (_label, message) => {
    const h = await startBroker();
    const relay = await FakeRelay.open(h.url, h.token);
    relay.sendRaw(message);
    await expect(relay.closed).resolves.toMatchObject({ code: 1002 });
  });

  it("closes with 1002 on a second hello", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    relay.hello();
    await expect(relay.closed).resolves.toMatchObject({ code: 1002 });
    await vi.waitFor(() => expect(h.broker.status(scope, "office")).toBe("down"));
  });
});

describe("heartbeats", () => {
  it("acknowledges each heartbeat", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    relay.send({ type: "hb" });
    await expect(relay.next("hb_ack")).resolves.toStrictEqual({ type: "hb_ack" });
  });

  it("reports a relay down after the missed heartbeats, and closes its connection", async () => {
    const h = await startBroker({ heartbeatIntervalMs: 100, missedHeartbeats: 2 });
    const relay = await FakeRelay.connect(h.url, h.token);
    await relay.closed;
    await vi.waitFor(() => expect(h.broker.status(scope, "office")).toBe("down"));
    expect(h.statuses.map((event) => [event.status, event.reason])).toStrictEqual([
      ["up", "connected"],
      ["down", "no heartbeat for 2 intervals"],
    ]);
  });

  it("keeps a relay up while it sends heartbeats", async () => {
    const h = await startBroker({ heartbeatIntervalMs: 100, missedHeartbeats: 2 });
    const relay = await FakeRelay.connect(h.url, h.token);
    const beat = setInterval(() => relay.send({ type: "hb" }), 50);
    await new Promise((resolve) => setTimeout(resolve, 500));
    clearInterval(beat);
    expect(h.broker.status(scope, "office")).toBe("up");
    expect(h.statuses.map((event) => event.status)).toStrictEqual(["up"]);
  });
});

describe("an HTTP call", () => {
  it("sends a signed envelope that binds the target, the workspace, the headers, and the body", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const request = httpRequest();
    const pending = h.broker.transport(scope).http(request);

    const frame = await relay.next("request");
    const envelope = relayEnvelopeSchema.parse(frame.envelope);
    expect(envelope.relay).toBe("office");
    expect(envelope.workspace).toBe(WORKSPACE);
    expect(envelope.target).toStrictEqual(httpTarget);
    expect(envelope.deadline_ms).toBe(5_000);
    expect(envelope.credential).toBeUndefined();
    expect(Date.parse(envelope.expires_at) - Date.parse(envelope.issued_at)).toBe(DEFAULT_ENVELOPE_TTL_MS);
    expect(frame.headers).toStrictEqual(request.headers);
    expect(envelope.headers_hash).toBe(relayHeadersHash(frame.headers));
    expect(Buffer.from(fromBase64(frame.body)).toString("utf8")).toBe('{"customer":"c-9"}');
    expect(envelope.body_hash).toBe(documentHash(fromBase64(frame.body)));
    expect(envelope.signature.key_id).toBe(h.signer.keyId);
    expect(signatureValid(envelope, h.signer)).toBe(true);

    relay.send({ type: "head", id: frame.id, status: 200, headers: [["content-type", "application/json"]] });
    relay.send({ type: "data", id: frame.id, chunk: toBase64(encoder.encode('{"ok":')) });
    relay.send({ type: "data", id: frame.id, chunk: toBase64(encoder.encode("true}")) });
    relay.send({ type: "end", id: frame.id });

    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.headers).toStrictEqual([["content-type", "application/json"]]);
    await expect(readText(response.body)).resolves.toBe('{"ok":true}');
  });

  it("gives each call a fresh nonce", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const transport = h.broker.transport(scope);
    void transport.http(httpRequest()).catch(() => undefined);
    void transport.http(httpRequest()).catch(() => undefined);
    const first = relayEnvelopeSchema.parse((await relay.next("request")).envelope);
    const second = relayEnvelopeSchema.parse((await relay.next("request")).envelope);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("reports a host the relay's allowlist does not name as refused_host, not sent", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).http(httpRequest());
    const frame = await relay.next("request");
    relay.send({ type: "refused", id: frame.id, code: "host_not_allowed", message: "billing.internal is not listed" });
    const error = await pending.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).toMatchObject({ code: "refused_host", sent: false });
  });

  it("times out after deadline_ms and the grace, and cancels the call at the relay", async () => {
    const h = await startBroker({ responseGraceMs: 50 });
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).http(httpRequest({ deadline_ms: 100 }));
    const frame = await relay.next("request");
    await expect(pending).rejects.toMatchObject({ code: "timeout", sent: true });
    await expect(relay.next("cancel")).resolves.toStrictEqual({ type: "cancel", id: frame.id });
  });

  it("fails an open call as disconnected, sent, when the relay drops mid-call", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).http(httpRequest());
    await relay.next("request");
    relay.terminate();
    await expect(pending).rejects.toMatchObject({ code: "disconnected", sent: true });
    await relay.closed;
    expect(h.broker.status(scope, "office")).toBe("down");
    expect(h.statuses.map((event) => event.status)).toStrictEqual(["up", "down"]);
  });

  it("refuses a relay that is not connected, not sent", async () => {
    const h = await startBroker();
    await expect(h.broker.transport(scope).http(httpRequest({ network: "relay:warehouse" }))).rejects.toMatchObject({
      code: "disconnected",
      sent: false,
    });
  });

  it("never routes to a relay of another workspace with the same name", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const other: RelayScope = { ...scope, workspaceId: "ws-2", workspacePublicId: "wrk_zzzzzzzzzzzzzzzzzzzzzz" };
    await expect(h.broker.transport(other).http(httpRequest())).rejects.toMatchObject({
      code: "disconnected",
      sent: false,
    });
    expect(relay.unread()).toStrictEqual([]);
  });

  it("refuses a network that is not relay:<name>", async () => {
    const h = await startBroker();
    await expect(h.broker.transport(scope).http(httpRequest({ network: "cloud" }))).rejects.toMatchObject({
      code: "unsupported",
      sent: false,
    });
  });

  it("refuses a body over the frame limit, not sent", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const body = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
    await expect(h.broker.transport(scope).http(httpRequest({ body }))).rejects.toMatchObject({
      code: "unsupported",
      sent: false,
    });
    expect(relay.unread()).toStrictEqual([]);
  });

  it("sends nothing for a call the caller cancelled first", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const controller = new AbortController();
    controller.abort();
    await expect(
      h.broker.transport(scope).http(httpRequest({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: "not_sent", sent: false });
    expect(relay.unread()).toStrictEqual([]);
  });

  it("cancels at the relay when the caller aborts after the send", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const controller = new AbortController();
    const pending = h.broker.transport(scope).http(httpRequest({ signal: controller.signal }));
    const frame = await relay.next("request");
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled after it was sent/);
    await expect(relay.next("cancel")).resolves.toStrictEqual({ type: "cancel", id: frame.id });
  });

  it("cancels at the relay when the caller stops reading the body", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).http(httpRequest());
    const frame = await relay.next("request");
    relay.send({ type: "head", id: frame.id, status: 200, headers: [["content-type", "text/event-stream"]] });
    const response = await pending;
    response.cancel();
    await expect(relay.next("cancel")).resolves.toStrictEqual({ type: "cancel", id: frame.id });
  });

  it("ignores frames for a call it does not know", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    relay.send({ type: "end", id: "no-such-call" });
    relay.send({ type: "hb" });
    await expect(relay.next("hb_ack")).resolves.toStrictEqual({ type: "hb_ack" });
    expect(h.broker.status(scope, "office")).toBe("up");
  });
});

describe("a relay credential", () => {
  const credential = { name: "billing-token", scheme: "bearer" as const };

  it("goes into the signed envelope when the plan allows it", async () => {
    const entitled = vi.fn(() => Promise.resolve(true));
    const h = await startBroker({ credentialEntitled: entitled });
    const relay = await FakeRelay.connect(h.url, h.token);
    void h.broker
      .transport(scope)
      .http(httpRequest({ relay_credential: credential }))
      .catch(() => undefined);
    const envelope = relayEnvelopeSchema.parse((await relay.next("request")).envelope);
    expect(envelope.credential).toStrictEqual(credential);
    expect(signatureValid(envelope, h.signer)).toBe(true);
    expect(entitled).toHaveBeenCalledWith("org-1", "enterprise");
  });

  it("passes no plan tier when the caller has none, so the check looks it up", async () => {
    const entitled = vi.fn(() => Promise.resolve(true));
    const h = await startBroker({ credentialEntitled: entitled });
    const relay = await FakeRelay.connect(h.url, h.token);
    const { planTier: _tier, ...noTier } = scope;
    void h.broker
      .transport(noTier)
      .http(httpRequest({ relay_credential: credential }))
      .catch(() => undefined);
    await relay.next("request");
    expect(entitled).toHaveBeenCalledWith("org-1", undefined);
  });

  it("is refused below the Enterprise plan, and nothing is sent", async () => {
    const h = await startBroker({ credentialEntitled: () => Promise.resolve(false) });
    const relay = await FakeRelay.connect(h.url, h.token);
    const error = await h.broker
      .transport({ ...scope, planTier: "scale" })
      .http(httpRequest({ relay_credential: credential }))
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "unsupported", sent: false });
    expect((error as Error).message).toContain("Enterprise");
    expect(relay.unread()).toStrictEqual([]);
  });

  it("is refused, not sent, when the plan check fails", async () => {
    const h = await startBroker({ credentialEntitled: () => Promise.reject(new Error("billing down")) });
    const relay = await FakeRelay.connect(h.url, h.token);
    await expect(
      h.broker.transport(scope).http(httpRequest({ relay_credential: credential })),
    ).rejects.toMatchObject({ code: "not_sent", sent: false });
    expect(relay.unread()).toStrictEqual([]);
  });

  it("is not checked for a call without one", async () => {
    const entitled = vi.fn(() => Promise.resolve(false));
    const h = await startBroker({ credentialEntitled: entitled });
    const relay = await FakeRelay.connect(h.url, h.token);
    void h.broker.transport(scope).http(httpRequest()).catch(() => undefined);
    await relay.next("request");
    expect(entitled).not.toHaveBeenCalled();
  });
});

describe("a gRPC call", () => {
  it("names the service and method, and returns each message and the status", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const request = grpcRequest();
    const pending = h.broker.transport(scope).grpc(request);

    const frame = await relay.next("request");
    const envelope = relayEnvelopeSchema.parse(frame.envelope);
    expect(envelope.target).toStrictEqual(grpcTarget);
    expect(frame.headers).toStrictEqual([["x-trace-id", "t-1"]]);
    expect(envelope.headers_hash).toBe(relayHeadersHash(request.metadata));
    expect(envelope.body_hash).toBe(documentHash(request.message));
    expect(signatureValid(envelope, h.signer)).toBe(true);

    relay.send({ type: "head", id: frame.id, status: 200, headers: [] });
    relay.send({ type: "data", id: frame.id, chunk: toBase64(new Uint8Array([8, 1])) });
    relay.send({ type: "data", id: frame.id, chunk: toBase64(new Uint8Array([8, 2])) });
    relay.send({ type: "trailers", id: frame.id, code: 0, message: "", metadata: [["x-served-by", "l1"]] });

    const response = await pending;
    const messages: number[][] = [];
    for await (const message of response.messages) messages.push([...message]);
    expect(messages).toStrictEqual([
      [8, 1],
      [8, 2],
    ]);
    await expect(response.status()).resolves.toStrictEqual({
      code: 0,
      message: "",
      metadata: [["x-served-by", "l1"]],
    });
  });

  it("refuses a call the relay refused before the head", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).grpc(grpcRequest());
    const frame = await relay.next("request");
    relay.send({ type: "refused", id: frame.id, code: "expired", message: "the envelope expired" });
    await expect(pending).rejects.toMatchObject({ code: "not_sent", sent: false });
  });
});

describe("local calls", () => {
  it("are not carried by a relay", async () => {
    const h = await startBroker();
    await expect(
      h.broker.transport(scope).local({
        tool: "files__read_file",
        upstream: "read_file",
        version: 1,
        definition_hash: `sha256:${"0".repeat(64)}`,
        package_digest: `sha256:${"0".repeat(64)}`,
        arguments: {},
        deadline_ms: 1_000,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "unsupported", sent: false });
  });
});

describe("several connections for one relay", () => {
  it("share the calls in turn, and the relay stays up until the last one closes", async () => {
    const h = await startBroker();
    const first = await FakeRelay.connect(h.url, h.token);
    const second = await FakeRelay.connect(h.url, h.token);
    const transport = h.broker.transport(scope);
    void transport.http(httpRequest()).catch(() => undefined);
    void transport.http(httpRequest()).catch(() => undefined);
    await first.next("request");
    await second.next("request");
    expect(h.statuses.map((event) => event.status)).toStrictEqual(["up"]);

    first.terminate();
    await first.closed;
    // The broker sees the close a moment after the relay does.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.broker.status(scope, "office")).toBe("up");
    void transport.http(httpRequest()).catch(() => undefined);
    await second.next("request");

    second.terminate();
    await second.closed;
    await vi.waitFor(() => expect(h.broker.status(scope, "office")).toBe("down"));
    expect(h.statuses.map((event) => event.status)).toStrictEqual(["up", "down"]);
  });
});

describe("close", () => {
  it("closes every relay connection and fails open calls", async () => {
    const h = await startBroker();
    const relay = await FakeRelay.connect(h.url, h.token);
    const pending = h.broker.transport(scope).http(httpRequest());
    await relay.next("request");
    await h.broker.close();
    await expect(pending).rejects.toMatchObject({ code: "disconnected", sent: true });
    await relay.closed;
  });
});
