// verify.ts: the checks every request passes before the relay sends it.
//
// The relay acts only on an envelope the cloud gateway signed. It checks the
// envelope and the request against it in a fixed order, and the first check
// that fails names the refusal. Nothing is sent upstream for a refused
// request. The order matters in two places:
//
// - The nonce is claimed only once the signature, the relay, the workspace,
//   and the time window pass, so nobody can use up a nonce with a forged
//   envelope.
// - The credential is added last, after the headers match the signed hash,
//   so the signed headers never hold the customer's secret.
import { verify } from "node:crypto";
import {
  documentHash,
  envelopeSigningBytes,
  relayEnvelopeSchema,
  relayHeadersHash,
  type RelayEnvelope,
} from "@oxagen/mcp-studio";
import { fromBase64, type BrokerFrame, type RelayRefusalCode } from "@oxagen/relay-broker/protocol";
import type { RelayConfig } from "./config";
import { addCredential, type HeaderEntry } from "./credentials";
import type { NonceCache } from "./nonces";

/** How long the relay waits for a response when the envelope names no deadline. */
export const DEFAULT_DEADLINE_MS = 30_000;

export type RequestFrame = Extract<BrokerFrame, { type: "request" }>;

export type VerifySettings = Pick<
  RelayConfig,
  "relay" | "workspace" | "trustedKeys" | "allowedHosts" | "clockSkewMs" | "credentials"
>;

export interface VerifyContext {
  config: VerifySettings;
  nonces: NonceCache;
  /** When this relay process started, in epoch ms. */
  startedAt: number;
  now: number;
}

export interface Accepted {
  ok: true;
  envelope: RelayEnvelope;
  /** The headers or gRPC metadata to send, with the credential added. */
  headers: HeaderEntry[];
  body: Uint8Array;
  deadlineMs: number;
}

export interface Refused {
  ok: false;
  code: RelayRefusalCode;
  message: string;
}

function refuse(code: RelayRefusalCode, message: string): Refused {
  return { ok: false, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function signatureValid(raw: Record<string, unknown>, envelope: RelayEnvelope, config: VerifySettings): boolean {
  const key = config.trustedKeys.get(envelope.signature.key_id);
  if (key === undefined) return false;
  try {
    // The signature covers the envelope exactly as it arrived.
    return verify(null, envelopeSigningBytes(raw), key, Buffer.from(envelope.signature.sig, "base64"));
  } catch {
    return false;
  }
}

// An RFC 9110 token: the characters a header name may hold.
const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// The characters Node refuses in a header value (its checkInvalidHeaderChar):
// every control character but tab, DEL, and anything past U+00FF.
const UNSAFE_VALUE = /[^\t\x20-\x7e\x80-\xff]/;

/**
 * Headers that describe the connection rather than the request. The relay
 * sets them itself from the target and the body, so a request that carries
 * one could make the upstream read something other than what was signed.
 */
const CONNECTION_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
]);

function httpHeaderProblem(headers: readonly HeaderEntry[], bodyBytes: number): string | undefined {
  for (const [name, value] of headers) {
    if (!HTTP_TOKEN.test(name)) return `The header name ${JSON.stringify(name)} is not an HTTP token.`;
    if (UNSAFE_VALUE.test(value)) return `The ${name} header holds a character an HTTP header cannot carry.`;
    const lower = name.toLowerCase();
    if (CONNECTION_HEADERS.has(lower)) return `The request carries a ${lower} header, which the relay sets itself.`;
    if (lower === "content-length" && value.trim() !== String(bodyBytes)) {
      return `The content-length header says ${value}, and the body is ${bodyBytes} bytes.`;
    }
  }
  return undefined;
}

// grpc-js takes lowercase letters, digits, _, ., and - in a metadata name.
const GRPC_KEY = /^[0-9a-z_.-]+$/;
const GRPC_TEXT_VALUE = /^[ -~]*$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function grpcMetadataProblem(metadata: readonly HeaderEntry[]): string | undefined {
  for (const [name, value] of metadata) {
    const lower = name.toLowerCase();
    if (!GRPC_KEY.test(lower)) return `The metadata name ${JSON.stringify(name)} is not a gRPC metadata name.`;
    if (lower.startsWith("grpc-")) return `The metadata name ${lower} is reserved for gRPC itself.`;
    if (lower.endsWith("-bin")) {
      if (!BASE64.test(value)) return `The ${lower} metadata value is not base64.`;
    } else if (!GRPC_TEXT_VALUE.test(value)) {
      return `The ${lower} metadata value holds a character outside printable ASCII.`;
    }
  }
  return undefined;
}

/**
 * Headers a header credential may not name. The relay adds the credential
 * after it checks the signed headers, so the credential's header gets its own
 * check here. A credential that set host, for example, could send the request
 * to another virtual host behind an allowed proxy.
 */
const CREDENTIAL_HTTP_RESERVED = new Set([...CONNECTION_HEADERS, "content-length"]);
const CREDENTIAL_GRPC_RESERVED = new Set([...CONNECTION_HEADERS, "content-length", "content-type"]);

/** Why the relay cannot send a header credential's header. The message names the header, never its value. */
function credentialHeaderProblem(credential: RelayEnvelope["credential"], kind: "http" | "grpc"): string | undefined {
  if (credential?.scheme !== "header" || credential.header === undefined) return undefined;
  const lower = credential.header.toLowerCase();
  const reserved =
    kind === "http"
      ? CREDENTIAL_HTTP_RESERVED.has(lower)
      : CREDENTIAL_GRPC_RESERVED.has(lower) || !GRPC_KEY.test(lower) || lower.startsWith("grpc-") || lower.endsWith("-bin");
  if (!reserved) return undefined;
  return `Credential ${credential.name} names the ${lower} header, which a credential cannot set. Name another header for the credential.`;
}

function defaultPort(scheme: "https" | "http"): number {
  return scheme === "https" ? 443 : 80;
}

function hostAllowed(target: RelayEnvelope["target"], config: VerifySettings): boolean {
  const port = target.port ?? defaultPort(target.scheme);
  if (config.allowedHosts.exact.has(`${target.host}:${port}`)) return true;
  return port === defaultPort(target.scheme) && config.allowedHosts.defaultPort.has(target.host);
}

/** Check one request frame. Accepted means the relay may send it exactly as the envelope names it. */
export function verifyRequest(frame: Pick<RequestFrame, "envelope" | "headers" | "body">, context: VerifyContext): Accepted | Refused {
  const { config, now } = context;
  const raw = frame.envelope;
  if (!isRecord(raw)) return refuse("invalid", "The envelope is not a JSON object.");
  if (raw.signature === undefined) return refuse("unsigned", "The envelope carries no signature.");

  const parsed = relayEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "the envelope" : issue.path.join(".");
    return refuse("invalid", `The envelope is not a valid relay-envelope/v1: ${where}: ${issue?.message ?? "invalid"}.`);
  }
  const envelope = parsed.data;

  if (!config.trustedKeys.has(envelope.signature.key_id)) {
    return refuse(
      "untrusted_key",
      `The envelope is signed with key ${envelope.signature.key_id}, and RELAY_TRUSTED_KEYS does not hold it.`,
    );
  }
  if (!signatureValid(raw, envelope, config)) {
    return refuse("bad_signature", "The envelope's signature does not match its contents.");
  }
  if (envelope.relay !== config.relay) {
    return refuse("wrong_relay", `The envelope is for relay ${envelope.relay}, and this relay is ${config.relay}.`);
  }
  if (envelope.workspace !== config.workspace) {
    return refuse(
      "wrong_workspace",
      `The envelope is for workspace ${envelope.workspace}, and this relay belongs to ${config.workspace}.`,
    );
  }

  const skew = config.clockSkewMs;
  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (now < issued - skew) {
    return refuse("not_yet_valid", `The envelope is issued for ${envelope.issued_at}, later than this relay's clock allows.`);
  }
  if (now >= expires + skew) return refuse("expired", `The envelope expired at ${envelope.expires_at}.`);
  // An earlier process may have accepted this envelope, and its nonces died
  // with it. Only an envelope issued more than the clock skew after this
  // process started is provably new to it.
  if (issued < context.startedAt + skew) {
    return refuse(
      "expired",
      "The envelope was issued before this relay process started, or within the clock skew after it, so the relay cannot tell it is new.",
    );
  }

  const claim = context.nonces.claim(envelope.nonce, expires + skew, now);
  if (claim === "replayed") return refuse("replayed", "The relay already accepted an envelope with this nonce.");
  if (claim === "full") return refuse("busy", "The relay is tracking as many envelopes as it can. Try again shortly.");

  if (relayHeadersHash(frame.headers) !== envelope.headers_hash) {
    return refuse("headers_mismatch", "The request's headers do not match the envelope's headers_hash.");
  }
  const body = fromBase64(frame.body);
  if (documentHash(body) !== envelope.body_hash) {
    return refuse("body_mismatch", "The request's body does not match the envelope's body_hash.");
  }

  const { target } = envelope;
  const headerProblem =
    (target.kind === "http" ? httpHeaderProblem(frame.headers, body.byteLength) : grpcMetadataProblem(frame.headers)) ??
    credentialHeaderProblem(envelope.credential, target.kind);
  if (headerProblem !== undefined) return refuse("invalid", headerProblem);

  if (!hostAllowed(target, config)) {
    const port = target.port ?? defaultPort(target.scheme);
    return refuse("host_not_allowed", `RELAY_ALLOWED_HOSTS does not name ${target.host}:${port}.`);
  }

  const credential = addCredential(frame.headers, envelope.credential, config.credentials, target.kind);
  if (!credential.ok) return refuse("credential_missing", credential.message);
  // The headers as sent, credential included, pass the same rules as the
  // signed ones. Only the content-length message quotes a value, and a
  // credential cannot name content-length, so no refusal here quotes a secret.
  const sentProblem =
    target.kind === "http" ? httpHeaderProblem(credential.headers, body.byteLength) : grpcMetadataProblem(credential.headers);
  if (sentProblem !== undefined) return refuse("invalid", sentProblem);

  return {
    ok: true,
    envelope,
    headers: credential.headers,
    body,
    deadlineMs: envelope.deadline_ms ?? DEFAULT_DEADLINE_MS,
  };
}
