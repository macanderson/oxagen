// sender.ts: the Sender interface, one per request template kind
// (mcp-studio-spec, Call path, step 5).
//
// execute() validates and shapes the input, asks the CredentialSource for
// the credential, and hands the call to the Sender for the tool's request
// template kind. The Sender builds the request, sends it through the
// Transport, applies its kind's retry rule, and returns the upstream's value.
// execute() then shapes the result.
import type { ManifestAuth, ManifestServer, ManifestShaping } from "../contract/manifest";
import type { RecordedExchange } from "../contract/tests-files";
import type { RequestKind, RequestTemplate } from "../model/upstream-tool";
import type { ResolvedCredential } from "./credentials";
import type { Transport } from "./transport";

/** A credential a Sender applies. execute() handles the missing variant before any send. */
export type SendCredential = Exclude<ResolvedCredential, { type: "missing" }> | { type: "none" };

export interface SendContext {
  server: ManifestServer;
  /** The environment's name and its resolved url and network. */
  environment: { name: string; url: string | undefined; network: string };
  /** How the credential is applied, or null for a server with no auth. */
  auth: ManifestAuth | null;
  credential: SendCredential;
  transport: Transport;
  shaping: ManifestShaping;
  /** The key for shaping.idempotency_header, the same on every retry of one call. */
  idempotency_key: string | undefined;
  signal: AbortSignal;
}

/** Why a send failed, in RFC 9457 terms: the upstream's title and detail when it gave them. */
export interface SendError {
  title: string;
  detail: string;
  /** The HTTP status, the gRPC status code, or undefined when no response arrived. */
  status: number | undefined;
}

export type SendResult =
  | {
      ok: true;
      /** The upstream's result: a JSON value, an MCP tools/call result, or { items, truncated } for a gRPC stream. */
      value: unknown;
      /** How many attempts the send took, 1 with no retry. */
      attempts: number;
      /** The final attempt's request and response, for Try it to save as a test. */
      exchanges?: RecordedExchange[];
    }
  | { ok: false; error: SendError; attempts: number; exchanges?: RecordedExchange[] };

/** The upstream arguments: the agent's input after fixed, defaults, and rename were applied. */
export type UpstreamArguments = Record<string, unknown>;

export interface Sender<K extends RequestKind> {
  readonly kind: K;
  send(
    template: Extract<RequestTemplate, { kind: K }>,
    args: UpstreamArguments,
    context: SendContext,
  ): Promise<SendResult>;
}

/** One Sender for each request template kind. */
export type Senders = { readonly [K in RequestKind]: Sender<K> };
