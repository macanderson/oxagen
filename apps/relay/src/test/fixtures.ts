// fixtures.ts: keys, settings, signed envelopes, and a recording sink for the relay's tests.
//
// The fixtures sign with node:crypto directly, over the same canonical bytes
// the broker signs, so a unit test needs no broker.
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { documentHash, envelopeSigningBytes, relayHeadersHash, type RelayEnvelope } from "@oxagen/mcp-studio";
import { relayKeyId, toBase64, type RelayFailureCode } from "@oxagen/relay-broker/protocol";
import type { RelayConfig } from "../config";
import type { HeaderEntry } from "../credentials";
import type { ResponseSink } from "../sink";
import type { RequestFrame } from "../verify";

export const RELAY = "office";
export const WORKSPACE = "wrk_0123456789abcdefghjkmn";
/** A fixed clock for tests that do not care about time. */
export const NOW = Date.parse("2026-09-28T12:00:00.000Z");

export interface TestKey {
  keyId: string;
  publicKey: KeyObject;
  privateKey: KeyObject;
  publicKeyPem: string;
}

/** A fresh ed25519 signing key and its key id. */
export function testKey(): TestKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { keyId: relayKeyId(publicKeyPem), publicKey, privateKey, publicKeyPem };
}

/** Relay settings that trust `key` and allow ledger.internal:50051 and billing.internal at its default port. */
export function testConfig(key: TestKey, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    brokerUrl: "ws://127.0.0.1:1/relay/v1/connect",
    token: "rt_test_token",
    relay: RELAY,
    workspace: WORKSPACE,
    trustedKeys: new Map([[key.keyId, key.publicKey]]),
    allowedHosts: { exact: new Set(["ledger.internal:50051"]), defaultPort: new Set(["billing.internal"]) },
    clockSkewMs: 0,
    maxResponseBytes: 8 * 1024 * 1024,
    credentials: new Map(),
    ...overrides,
  };
}

export type UnsignedEnvelope = Omit<RelayEnvelope, "signature">;
export type EnvelopeTarget = RelayEnvelope["target"];

export interface EnvelopeSpec {
  target?: EnvelopeTarget;
  headers?: readonly HeaderEntry[];
  body?: Uint8Array | string;
  /** Epoch ms. Defaults to NOW. */
  issuedAt?: number;
  /** Defaults to 10 seconds. */
  ttlMs?: number;
  nonce?: string;
  relay?: string;
  workspace?: string;
  deadlineMs?: number;
  credential?: RelayEnvelope["credential"];
}

export const HTTP_TARGET: EnvelopeTarget = {
  kind: "http",
  scheme: "https",
  method: "POST",
  host: "billing.internal",
  path: "/v1/invoices?limit=5",
};

export const GRPC_TARGET: EnvelopeTarget = {
  kind: "grpc",
  scheme: "http",
  host: "ledger.internal",
  port: 50051,
  service: "a_intel.ledger.v1.Ledger",
  method: "PostEntry",
};

/** A random nonce in the envelope's alphabet. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

function bytesOf(body: Uint8Array | string | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array();
  return typeof body === "string" ? new TextEncoder().encode(body) : body;
}

/** An unsigned envelope whose hashes match the spec's headers and body. */
export function unsignedEnvelope(spec: EnvelopeSpec = {}): UnsignedEnvelope {
  const issuedAt = spec.issuedAt ?? NOW;
  const envelope: UnsignedEnvelope = {
    schema: "relay-envelope/v1",
    relay: spec.relay ?? RELAY,
    workspace: spec.workspace ?? WORKSPACE,
    nonce: spec.nonce ?? newNonce(),
    issued_at: new Date(issuedAt).toISOString(),
    expires_at: new Date(issuedAt + (spec.ttlMs ?? 10_000)).toISOString(),
    target: spec.target ?? HTTP_TARGET,
    headers_hash: relayHeadersHash(spec.headers ?? []),
    body_hash: documentHash(bytesOf(spec.body)),
  };
  if (spec.deadlineMs !== undefined) envelope.deadline_ms = spec.deadlineMs;
  if (spec.credential !== undefined) envelope.credential = spec.credential;
  return envelope;
}

/** Sign an envelope as the broker does: ed25519 over its canonical bytes without the signature. */
export function signEnvelope(unsigned: UnsignedEnvelope, key: TestKey): RelayEnvelope {
  const sig = sign(null, envelopeSigningBytes(unsigned), key.privateKey).toString("base64");
  return { ...unsigned, signature: { key_id: key.keyId, alg: "ed25519", sig } };
}

/** A request frame carrying a signed envelope, the spec's headers, and its body. */
export function requestFrame(key: TestKey, spec: EnvelopeSpec = {}, id = "call-1"): RequestFrame {
  return {
    type: "request",
    id,
    envelope: signEnvelope(unsignedEnvelope(spec), key),
    headers: (spec.headers ?? []).map(([name, value]): [string, string] => [name, value]),
    body: toBase64(bytesOf(spec.body)),
  };
}

export type SinkEvent =
  | { kind: "head"; status: number; headers: HeaderEntry[] }
  | { kind: "data"; chunk: Uint8Array }
  | { kind: "end" }
  | { kind: "trailers"; code: number; message: string; metadata: HeaderEntry[] }
  | { kind: "fail"; code: RelayFailureCode; message: string; sent: boolean };

/**
 * A sink that records every call and resolves `done` at the first terminal
 * event. `accept` decides what data() resolves to.
 */
export class RecordingSink implements ResponseSink {
  readonly events: SinkEvent[] = [];
  closed = false;
  readonly done: Promise<SinkEvent>;
  private resolveDone: (event: SinkEvent) => void = () => undefined;

  constructor(private readonly accept: (chunk: Uint8Array) => Promise<boolean> = () => Promise.resolve(true)) {
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  head(status: number, headers: readonly HeaderEntry[]): void {
    this.events.push({ kind: "head", status, headers: [...headers] });
  }

  data(chunk: Uint8Array): Promise<boolean> {
    this.events.push({ kind: "data", chunk: Uint8Array.from(chunk) });
    return this.accept(chunk);
  }

  end(): void {
    this.terminal({ kind: "end" });
  }

  trailers(code: number, message: string, metadata: readonly HeaderEntry[]): void {
    this.terminal({ kind: "trailers", code, message, metadata: [...metadata] });
  }

  fail(code: RelayFailureCode, message: string, sent: boolean): void {
    this.terminal({ kind: "fail", code, message, sent });
  }

  /** Every data chunk joined. */
  body(): Buffer {
    return Buffer.concat(this.events.flatMap((event) => (event.kind === "data" ? [event.chunk] : [])));
  }

  private terminal(event: SinkEvent): void {
    this.events.push(event);
    if (this.closed) return;
    this.closed = true;
    this.resolveDone(event);
  }
}
