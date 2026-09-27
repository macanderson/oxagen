// transport.ts: the Transport interface (mcp-studio-spec, Call path and
// Network paths).
//
// A Sender builds the bytes of one request, and a Transport carries them to
// the upstream on the route the environment names:
//
// - cloud: straight from Oxagen. It refuses private, loopback, and
//   link-local addresses, and a redirect to another host.
// - relay:<name>: through lane M12's relay broker, which signs a
//   relay-envelope/v1 from the request's target and body.
// - a local server: through lane M14's local gateway, which receives a
//   signed local-call-envelope/v1.
//
// The HTTP and gRPC targets are exactly a relay envelope's targets, scheme
// included, so the relay broker builds an envelope with no interpretation.
// The envelope binds the headers or metadata with headers_hash
// (relayHeadersHash) and the body with body_hash. A Transport that cannot
// carry a kind of request rejects it with TransportError code "unsupported".
import type { z } from "zod";
import type { relayGrpcTargetSchema, relayHttpTargetSchema } from "../contract/relay-envelope";
import type { RelayCredential } from "./credentials";

/** The scheme, method, host, port, and path of one HTTP request: a relay envelope's http target. */
export type HttpTarget = z.output<typeof relayHttpTargetSchema>;
/** The scheme, host, port, service, and method of one gRPC call: a relay envelope's grpc target. */
export type GrpcTarget = z.output<typeof relayGrpcTargetSchema>;

/** A header or metadata entry. Names may repeat, so this is a list, not a map. */
export type HeaderEntry = readonly [name: string, value: string];

interface RequestCommon {
  /** cloud, or relay:<name>, as the environment resolved it. */
  network: string;
  /** Every send has one. 30,000 unless tools.toml sets deadline_ms. */
  deadline_ms: number;
  signal: AbortSignal;
  /** A credential the relay adds itself. Set only on a relay network. */
  relay_credential: RelayCredential | undefined;
}

/** One HTTP request: an OpenAPI operation, a GraphQL POST, or an MCP streamable HTTP message. */
export interface HttpTransportRequest extends RequestCommon {
  target: HttpTarget;
  headers: readonly HeaderEntry[];
  /** The exact body bytes. Empty for none, which hashes as the empty string in an envelope. */
  body: Uint8Array;
}

export interface HttpTransportResponse {
  status: number;
  headers: readonly HeaderEntry[];
  /** The body as it arrives, so an MCP event stream or a large body can be read in parts. */
  body: AsyncIterable<Uint8Array>;
  /** Stop reading and release the connection. */
  cancel(): void;
}

/** One gRPC call, unary or server streaming. */
export interface GrpcTransportRequest extends RequestCommon {
  target: GrpcTarget;
  metadata: readonly HeaderEntry[];
  /** The one request message, encoded. */
  message: Uint8Array;
}

/** The status a gRPC call ended with, from its trailers. */
export interface GrpcStatus {
  /** 0 is OK. 14 is UNAVAILABLE. */
  code: number;
  message: string;
  metadata: readonly HeaderEntry[];
}

export interface GrpcTransportResponse {
  /** Each response message, encoded: one for a unary call. */
  messages: AsyncIterable<Uint8Array>;
  /** Resolves when the call ends. */
  status(): Promise<GrpcStatus>;
  /** Cancel the call, such as when a stream reaches max_items. */
  cancel(): void;
}

/** One call to a local server, which lane M14 signs into a local-call-envelope/v1. */
export interface LocalCall {
  /** The tool the agent called: files__read_file. */
  tool: string;
  /** The name the local server knows the tool by. */
  upstream: string;
  version: number;
  definition_hash: string;
  /** The lock's package digest. The local gateway refuses a command that does not match. */
  package_digest: string;
  /** The upstream arguments, after the input was shaped. */
  arguments: Record<string, unknown>;
  /** The local call envelope signs it, so the local gateway stops the call when it passes. */
  deadline_ms: number;
  signal: AbortSignal;
}

export interface Transport {
  http(request: HttpTransportRequest): Promise<HttpTransportResponse>;
  grpc(request: GrpcTransportRequest): Promise<GrpcTransportResponse>;
  /** Returns the local server's tools/call result, before the cloud gateway shapes it. */
  local(call: LocalCall): Promise<CallToolResult>;
}

/** An MCP tools/call result (MCP 2025-06-18). */
export interface CallToolResult {
  content: ReadonlyArray<{ type: string } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export const TRANSPORT_ERROR_CODES = [
  "refused_address",
  "refused_redirect",
  "refused_host",
  "unsupported",
  "timeout",
  "disconnected",
  "not_sent",
] as const;
export type TransportErrorCode = (typeof TRANSPORT_ERROR_CODES)[number];

/**
 * A request the Transport could not complete.
 *
 * - refused_address: the cloud route refused a private, loopback, or
 *   link-local address.
 * - refused_redirect: the upstream redirected to another host.
 * - refused_host: the relay's allowlist does not name the host.
 * - unsupported: this Transport does not carry the kind of request.
 * - timeout: deadline_ms passed.
 * - disconnected: the relay or the local gateway is not connected.
 * - not_sent: the connection failed before the request left.
 *
 * `sent` says whether the upstream may have received the request. MCP
 * retries only when it is false.
 */
export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly sent: boolean;

  constructor(code: TransportErrorCode, message: string, sent: boolean) {
    super(message);
    this.name = "TransportError";
    this.code = code;
    this.sent = sent;
  }
}
