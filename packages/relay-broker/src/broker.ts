// broker.ts: the Oxagen side of the relay (mcp-studio-spec, Network paths).
//
// A relay inside a customer's network dials out to the broker and holds one
// WebSocket connection open. The broker checks the relay token before the
// upgrade, checks the relay's hello against the token's record, and then
// routes calls to it by organization, workspace, and relay name. For each
// call it signs a relay-envelope/v1 with a short expiry, sends it with the
// headers and body the envelope binds, and waits for the response within the
// call's deadline.
//
// The relay sends a heartbeat on the interval the welcome frame gives. The
// broker marks a connection down after DEFAULT_MISSED_HEARTBEATS intervals
// with no frame, closes it, and fails its open calls. The broker never
// replays a call on another connection.
//
// A host app mounts the broker by passing its HTTP server's upgrade events
// for the connect path to handleUpgrade, and gives each call path the
// Transport from transport(scope).
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  documentHash,
  relayEnvelopeSchema,
  relayHeadersHash,
  TransportError,
  type GrpcTarget,
  type GrpcTransportRequest,
  type GrpcTransportResponse,
  type HeaderEntry,
  type HttpTarget,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type RelayCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import type { PlanTier } from "@oxagen/oxagen/types";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { RelayCall } from "./call";
import { relayCredentialEntitled, type CredentialEntitlement } from "./entitlement";
import {
  CLOSE_HELLO_MISMATCH,
  CLOSE_NO_HELLO,
  decodeRelayFrame,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_MISSED_HEARTBEATS,
  encodeFrame,
  MAX_FRAME_BYTES,
  MAX_REQUEST_BODY_BYTES,
  RELAY_PROTOCOL_VERSION,
  toBase64,
  type BrokerFrame,
} from "./protocol/frames";
import { newNonce, signRelayEnvelope, type RelaySigner, type UnsignedRelayEnvelope } from "./signer";
import type { RelayIdentity, RelayTokenVerifier } from "./tokens";

/** How long an envelope stays valid. It covers the trip to the relay, not the call. */
export const DEFAULT_ENVELOPE_TTL_MS = 10_000;

/** How long past deadline_ms the broker waits, so the relay's own timeout arrives first. */
export const DEFAULT_RESPONSE_GRACE_MS = 2_000;

/** The caller a Transport acts for. The envelope's workspace comes from here, never from the connection. */
export interface RelayScope {
  orgId: string;
  workspaceId: string;
  /** The workspace's public id, wrk_…, which the envelope names and the relay checks. */
  workspacePublicId: string;
  /** The plan tier, when the caller already resolved it. The credential check looks it up otherwise. */
  planTier?: PlanTier;
}

export type RelayStatus = "up" | "down";

export interface RelayStatusEvent {
  orgId: string;
  workspaceId: string;
  relay: string;
  status: RelayStatus;
  reason: string;
  /** Epoch milliseconds. */
  at: number;
}

export interface RelayBrokerOptions {
  verifier: RelayTokenVerifier;
  signer: RelaySigner;
  /** Whether an organization may use a relay credential. Defaults to the Enterprise plan check. */
  credentialEntitled?: CredentialEntitlement;
  heartbeatIntervalMs?: number;
  missedHeartbeats?: number;
  envelopeTtlMs?: number;
  responseGraceMs?: number;
  now?: () => number;
  /** Called when a relay gains its first connection or loses its last. */
  onStatus?: (event: RelayStatusEvent) => void;
}

export interface RelayBroker {
  /** Take an HTTP upgrade for the connect path. It answers 401 before the upgrade when the token does not check. */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void>;
  /** The Transport for calls on relay:<name> networks, acting for one caller. */
  transport(scope: RelayScope): Transport;
  status(scope: Pick<RelayScope, "orgId" | "workspaceId">, relay: string): RelayStatus;
  /** Close every connection and stop the heartbeat check. */
  close(): Promise<void>;
}

const RELAY_NETWORK = /^relay:([a-z0-9][a-z0-9-]{0,62})$/;

function relayNameOf(network: string): string {
  const match = RELAY_NETWORK.exec(network);
  if (!match?.[1]) {
    throw new TransportError(
      "unsupported",
      `The relay broker carries only relay:<name> networks, and this call names ${network}.`,
      false,
    );
  }
  return match[1];
}

function routeKey(orgId: string, workspaceId: string, relay: string): string {
  return `${orgId}\u0000${workspaceId}\u0000${relay}`;
}

function bearerToken(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1];
}

function rawText(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function refuseUpgrade(socket: Duplex, status: 401 | 503, reason: string): void {
  // Destroy the socket only once the response has flushed, as ws does, so the
  // relay reads the status instead of a reset connection.
  socket.once("finish", () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

class RelayConnection {
  readonly calls = new Map<string, RelayCall>();
  ready = false;
  lastSeen: number;
  /** Why the relay went down, for the status event. */
  downReason = "the connection closed";

  constructor(
    readonly socket: WebSocket,
    readonly identity: RelayIdentity,
    now: number,
  ) {
    this.lastSeen = now;
  }

  get key(): string {
    return routeKey(this.identity.orgId, this.identity.workspaceId, this.identity.relay);
  }

  send(frame: BrokerFrame): boolean {
    if (this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(encodeFrame(frame));
    return true;
  }

  /** Drop the connection at once. Its close event fails the open calls. */
  markDown(reason: string): void {
    this.downReason = reason;
    this.socket.terminate();
  }
}

export function createRelayBroker(options: RelayBrokerOptions): RelayBroker {
  const heartbeatMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS;
  const missed = options.missedHeartbeats ?? DEFAULT_MISSED_HEARTBEATS;
  const ttlMs = options.envelopeTtlMs ?? DEFAULT_ENVELOPE_TTL_MS;
  const graceMs = options.responseGraceMs ?? DEFAULT_RESPONSE_GRACE_MS;
  const now = options.now ?? Date.now;
  const entitled = options.credentialEntitled ?? relayCredentialEntitled;
  const routes = new Map<string, RelayConnection[]>();
  const turns = new Map<string, number>();
  const sockets = new Set<RelayConnection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES, perMessageDeflate: false });

  function emit(identity: RelayIdentity, status: RelayStatus, reason: string): void {
    options.onStatus?.({
      orgId: identity.orgId,
      workspaceId: identity.workspaceId,
      relay: identity.relay,
      status,
      reason,
      at: now(),
    });
  }

  function addRoute(connection: RelayConnection): void {
    const list = routes.get(connection.key) ?? [];
    list.push(connection);
    routes.set(connection.key, list);
    if (list.length === 1) emit(connection.identity, "up", "connected");
  }

  function removeRoute(connection: RelayConnection, reason: string): void {
    const list = routes.get(connection.key);
    if (!list) return;
    const index = list.indexOf(connection);
    if (index === -1) return;
    list.splice(index, 1);
    if (list.length > 0) return;
    routes.delete(connection.key);
    turns.delete(connection.key);
    emit(connection.identity, "down", reason);
  }

  /** The next ready connection for a relay, in turn. */
  function pick(key: string): RelayConnection | undefined {
    const list = routes.get(key);
    if (!list || list.length === 0) return undefined;
    const turn = turns.get(key) ?? 0;
    turns.set(key, turn + 1);
    return list[turn % list.length];
  }

  function attach(socket: WebSocket, identity: RelayIdentity): void {
    const connection = new RelayConnection(socket, identity, now());
    sockets.add(connection);
    const helloTimer = setTimeout(() => socket.close(CLOSE_NO_HELLO, "no hello"), heartbeatMs);

    socket.on("message", (data, isBinary) => {
      connection.lastSeen = now();
      const frame = isBinary ? undefined : decodeRelayFrame(rawText(data));
      if (!frame) {
        socket.close(1002, "unreadable frame");
        return;
      }
      if (!connection.ready) {
        if (frame.type !== "hello") {
          socket.close(1002, "the first frame must be hello");
          return;
        }
        if (frame.relay !== identity.relay || frame.workspace !== identity.workspacePublicId) {
          socket.close(CLOSE_HELLO_MISMATCH, "the hello does not match the relay token");
          return;
        }
        clearTimeout(helloTimer);
        connection.ready = true;
        connection.send({ type: "welcome", protocol: RELAY_PROTOCOL_VERSION, heartbeat_ms: heartbeatMs });
        addRoute(connection);
        return;
      }
      switch (frame.type) {
        case "hb":
          connection.send({ type: "hb_ack" });
          return;
        case "hello":
          socket.close(1002, "hello sent twice");
          return;
        default:
          connection.calls.get(frame.id)?.receive(frame);
      }
    });

    socket.on("close", () => {
      clearTimeout(helloTimer);
      sockets.delete(connection);
      if (connection.ready) removeRoute(connection, connection.downReason);
      for (const call of [...connection.calls.values()]) call.disconnected();
    });
    socket.on("error", () => undefined);
  }

  const sweep = setInterval(() => {
    const cutoff = now() - heartbeatMs * missed;
    for (const connection of sockets) {
      if (connection.ready && connection.lastSeen < cutoff) {
        connection.markDown(`no heartbeat for ${missed} intervals`);
      }
    }
  }, heartbeatMs);
  sweep.unref();

  async function checkCredential(scope: RelayScope, credential: RelayCredential | undefined): Promise<void> {
    if (!credential) return;
    let allowed: boolean;
    try {
      allowed = await entitled(scope.orgId, scope.planTier);
    } catch (error) {
      throw new TransportError(
        "not_sent",
        `The plan check for relay credential ${credential.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        false,
      );
    }
    if (!allowed) {
      throw new TransportError(
        "unsupported",
        `Relay credential ${credential.name} needs the Enterprise plan. The call was not sent.`,
        false,
      );
    }
  }

  interface Dispatch {
    kind: "http" | "grpc";
    network: string;
    target: HttpTarget | GrpcTarget;
    headers: readonly HeaderEntry[];
    body: Uint8Array;
    deadlineMs: number;
    credential: RelayCredential | undefined;
    signal: AbortSignal;
  }

  async function dispatch(scope: RelayScope, request: Dispatch): Promise<RelayCall> {
    const relay = relayNameOf(request.network);
    await checkCredential(scope, request.credential);
    if (request.signal.aborted) {
      throw new TransportError("not_sent", "The call was cancelled before it was sent.", false);
    }
    if (request.body.byteLength > MAX_REQUEST_BODY_BYTES) {
      throw new TransportError(
        "unsupported",
        `The request body is ${request.body.byteLength} bytes, and a relay carries at most ${MAX_REQUEST_BODY_BYTES}.`,
        false,
      );
    }
    const connection = pick(routeKey(scope.orgId, scope.workspaceId, relay));
    if (!connection) {
      throw new TransportError("disconnected", `Relay ${relay} is not connected.`, false);
    }

    const issued = now();
    const unsigned: UnsignedRelayEnvelope = {
      schema: "relay-envelope/v1",
      relay,
      workspace: scope.workspacePublicId,
      nonce: newNonce(),
      issued_at: new Date(issued).toISOString(),
      expires_at: new Date(issued + ttlMs).toISOString(),
      target: request.target,
      headers_hash: relayHeadersHash(request.headers),
      body_hash: documentHash(request.body),
      deadline_ms: request.deadlineMs,
      ...(request.credential ? { credential: request.credential } : {}),
    };
    const envelope = signRelayEnvelope(unsigned, options.signer);
    const valid = relayEnvelopeSchema.safeParse(envelope);
    if (!valid.success) {
      const issue = valid.error.issues[0];
      throw new TransportError(
        "unsupported",
        `The broker could not build a valid relay envelope: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown issue"}.`,
        false,
      );
    }

    const id = randomUUID();
    const call = new RelayCall({
      id,
      kind: request.kind,
      relay,
      deadlineMs: request.deadlineMs,
      graceMs,
      signal: request.signal,
      sendCancel: () => connection.send({ type: "cancel", id }),
      onSettled: () => connection.calls.delete(id),
    });
    connection.calls.set(id, call);
    const sent = connection.send({
      type: "request",
      id,
      envelope,
      headers: request.headers.map(([name, value]) => [name, value] as [string, string]),
      body: toBase64(request.body),
    });
    if (!sent) {
      call.cancel();
      throw new TransportError("disconnected", `Relay ${relay} disconnected before the call was sent.`, false);
    }
    return call;
  }

  function transport(scope: RelayScope): Transport {
    return {
      async http(request: HttpTransportRequest): Promise<HttpTransportResponse> {
        const call = await dispatch(scope, {
          kind: "http",
          network: request.network,
          target: request.target,
          headers: request.headers,
          body: request.body,
          deadlineMs: request.deadline_ms,
          credential: request.relay_credential,
          signal: request.signal,
        });
        const head = await call.head;
        return { status: head.status, headers: head.headers, body: call.body.read(), cancel: () => call.cancel() };
      },

      async grpc(request: GrpcTransportRequest): Promise<GrpcTransportResponse> {
        const call = await dispatch(scope, {
          kind: "grpc",
          network: request.network,
          target: request.target,
          headers: request.metadata,
          body: request.message,
          deadlineMs: request.deadline_ms,
          credential: request.relay_credential,
          signal: request.signal,
        });
        await call.head;
        return { messages: call.body.read(), status: () => call.status(), cancel: () => call.cancel() };
      },

      local() {
        return Promise.reject(new TransportError("unsupported", "A relay does not carry local server calls.", false));
      },
    };
  }

  return {
    async handleUpgrade(request, socket, head) {
      const token = bearerToken(request.headers.authorization);
      let identity: RelayIdentity | null = null;
      if (token) {
        try {
          identity = await options.verifier.verify(token);
        } catch {
          refuseUpgrade(socket, 503, "Service Unavailable");
          return;
        }
      }
      if (!identity) {
        refuseUpgrade(socket, 401, "Unauthorized");
        return;
      }
      if (socket.destroyed) return;
      const known = identity;
      wss.handleUpgrade(request, socket, head, (ws) => attach(ws, known));
    },

    transport,

    status(scope, relay) {
      return routes.has(routeKey(scope.orgId, scope.workspaceId, relay)) ? "up" : "down";
    },

    close() {
      clearInterval(sweep);
      for (const connection of sockets) connection.socket.terminate();
      return new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}
