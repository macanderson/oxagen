// types.ts: what the connection hands an upstream sender for one call.
import type { RelayEnvelope } from "@oxagen/mcp-studio";
import type { ClientCertificate, HeaderEntry } from "../credentials";
import type { ResponseSink } from "../sink";

export type RelayHttpTarget = Extract<RelayEnvelope["target"], { kind: "http" }>;
export type RelayGrpcTarget = Extract<RelayEnvelope["target"], { kind: "grpc" }>;

/** One accepted request. The sender reports every outcome to the sink and never throws. */
export interface UpstreamCall<Target> {
  target: Target;
  /** The HTTP headers, or the gRPC metadata, with any credential added. */
  headers: readonly HeaderEntry[];
  /** The HTTP body, or the one gRPC request message. */
  body: Uint8Array;
  deadlineMs: number;
  /** The client certificate a mutual_tls credential presents. Only an https or TLS gRPC target gets one. */
  clientCert?: ClientCertificate;
  /** Aborts when the broker cancels the call, the connection closes, or the sink ends the call. */
  signal: AbortSignal;
  sink: ResponseSink;
}

export interface Upstreams {
  http(call: UpstreamCall<RelayHttpTarget>): void;
  grpc(call: UpstreamCall<RelayGrpcTarget>): void;
  /** Close idle connections. Calls in flight end through their signals. */
  close(): void;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
