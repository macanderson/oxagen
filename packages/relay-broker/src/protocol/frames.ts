// frames.ts: the messages the relay and the relay broker exchange over their
// one WebSocket connection (mcp-studio-spec, Network paths).
//
// Every frame is one JSON text message with a `type`. Bytes travel as base64.
// The relay opens the connection with its relay token and says hello. The
// broker checks the hello against the token's record and answers welcome.
// After that, the broker sends signed requests and the relay sends back each
// response in parts: a head, data, then an end for HTTP, or trailers for gRPC.
// The relay sends a heartbeat on a fixed interval and the broker acknowledges
// each one, so each side notices when the other goes quiet.
import { z } from "zod";

/** The protocol version both sides speak. A change that breaks either side raises it. */
export const RELAY_PROTOCOL_VERSION = 1;

/** The path the broker listens on for relay connections. */
export const RELAY_CONNECT_PATH = "/relay/v1/connect";

/** The largest frame either side accepts. It bounds one request body or one gRPC message. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** The largest request body the broker sends, so the base64 frame stays under MAX_FRAME_BYTES. */
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/** The size of each HTTP body part the relay sends back. */
export const DATA_CHUNK_BYTES = 64 * 1024;

/** How often the relay sends a heartbeat. The ALB closes a connection idle for 60 seconds. */
export const DEFAULT_HEARTBEAT_MS = 20_000;

/** How many heartbeat intervals either side waits before it treats the connection as down. */
export const DEFAULT_MISSED_HEARTBEATS = 3;

/** The WebSocket close code for a hello that does not match the relay token's record. */
export const CLOSE_HELLO_MISMATCH = 4003;

/** The WebSocket close code for a connection that sent no hello in time. */
export const CLOSE_NO_HELLO = 4008;

const callId = z.string().min(1).max(64);
const base64 = z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/, "not base64");
const headerEntries = z.array(z.tuple([z.string().min(1).max(256), z.string().max(65_536)])).max(1024);

/**
 * Why the relay refused a request before it sent anything upstream. The
 * broker reports host_not_allowed as refused_host and every other code as
 * not_sent.
 */
export const RELAY_REFUSAL_CODES = [
  "unsigned",
  "invalid",
  "untrusted_key",
  "bad_signature",
  "wrong_relay",
  "wrong_workspace",
  "not_yet_valid",
  "expired",
  "headers_mismatch",
  "body_mismatch",
  "host_not_allowed",
  "credential_missing",
  "replayed",
  "busy",
] as const;
export type RelayRefusalCode = (typeof RELAY_REFUSAL_CODES)[number];

/**
 * Why a request failed after the relay accepted it.
 *
 * - timeout: the envelope's deadline_ms passed.
 * - upstream: the connection to the upstream failed.
 * - too_large: the response passed the relay's size cap.
 * - cancelled: the broker cancelled the call.
 *
 * `sent` says whether the upstream may have received the request.
 */
export const RELAY_FAILURE_CODES = ["timeout", "upstream", "too_large", "cancelled"] as const;
export type RelayFailureCode = (typeof RELAY_FAILURE_CODES)[number];

export const welcomeFrameSchema = z
  .object({
    type: z.literal("welcome"),
    protocol: z.literal(RELAY_PROTOCOL_VERSION),
    heartbeat_ms: z.number().int().min(100).max(60_000),
  })
  .strict();

export const requestFrameSchema = z
  .object({
    type: z.literal("request"),
    id: callId,
    /** The signed relay-envelope/v1. The relay parses it itself. */
    envelope: z.unknown(),
    /** The HTTP headers, or the gRPC metadata, in send order. */
    headers: headerEntries,
    /** The HTTP body, or the one gRPC request message. */
    body: base64,
  })
  .strict();

export const cancelFrameSchema = z.object({ type: z.literal("cancel"), id: callId }).strict();

export const heartbeatAckFrameSchema = z.object({ type: z.literal("hb_ack") }).strict();

export const brokerFrameSchema = z.discriminatedUnion("type", [
  welcomeFrameSchema,
  requestFrameSchema,
  cancelFrameSchema,
  heartbeatAckFrameSchema,
]);
export type BrokerFrame = z.output<typeof brokerFrameSchema>;

export const helloFrameSchema = z
  .object({
    type: z.literal("hello"),
    protocol: z.literal(RELAY_PROTOCOL_VERSION),
    relay: z.string().min(1).max(63),
    workspace: z.string().min(1).max(68),
    version: z.string().max(64),
  })
  .strict();

export const heartbeatFrameSchema = z.object({ type: z.literal("hb") }).strict();

export const refusedFrameSchema = z
  .object({
    type: z.literal("refused"),
    id: callId,
    code: z.enum(RELAY_REFUSAL_CODES),
    message: z.string().max(2048),
  })
  .strict();

/** The response head. For gRPC it says the call started, with status 200 and the response metadata. */
export const headFrameSchema = z
  .object({
    type: z.literal("head"),
    id: callId,
    status: z.number().int().min(100).max(599),
    headers: headerEntries,
  })
  .strict();

/** A part of an HTTP body, or one whole gRPC response message. */
export const dataFrameSchema = z.object({ type: z.literal("data"), id: callId, chunk: base64 }).strict();

/** The HTTP body is complete. */
export const endFrameSchema = z.object({ type: z.literal("end"), id: callId }).strict();

/** The gRPC status the call ended with. */
export const trailersFrameSchema = z
  .object({
    type: z.literal("trailers"),
    id: callId,
    code: z.number().int().min(0).max(16),
    message: z.string().max(4096),
    metadata: headerEntries,
  })
  .strict();

export const failFrameSchema = z
  .object({
    type: z.literal("fail"),
    id: callId,
    code: z.enum(RELAY_FAILURE_CODES),
    message: z.string().max(2048),
    sent: z.boolean(),
  })
  .strict();

export const relayFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  heartbeatFrameSchema,
  refusedFrameSchema,
  headFrameSchema,
  dataFrameSchema,
  endFrameSchema,
  trailersFrameSchema,
  failFrameSchema,
]);
export type RelayFrame = z.output<typeof relayFrameSchema>;

/** One frame as the text the socket carries. */
export function encodeFrame(frame: BrokerFrame | RelayFrame): string {
  return JSON.stringify(frame);
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** A frame the broker sent, or undefined when the text is not one. */
export function decodeBrokerFrame(text: string): BrokerFrame | undefined {
  const parsed = brokerFrameSchema.safeParse(parseText(text));
  return parsed.success ? parsed.data : undefined;
}

/** A frame the relay sent, or undefined when the text is not one. */
export function decodeRelayFrame(text: string): RelayFrame | undefined {
  const parsed = relayFrameSchema.safeParse(parseText(text));
  return parsed.success ? parsed.data : undefined;
}

export function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
  const buffer = Buffer.from(text, "base64");
  return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
}
