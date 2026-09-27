// credentials.ts: the CredentialSource interface (mcp-studio-spec,
// Authentication). Lane M8 builds the implementation in
// packages/handlers/src/mcp-studio/credentials/, and the executor (M6)
// applies what it returns by the server's resolved scheme.
//
// A secret leaves the vault only inside a ResolvedCredential, which lives for
// one call. Nothing logs it, records it, or returns it to a client.
import type { ManifestAuth } from "../contract/manifest";
import type { z } from "zod";
import type { relayCredentialSchema } from "../contract/relay-envelope";

/** What the executor asks for before one call. */
export interface CredentialRequest {
  /** The server's name: billing. */
  server: string;
  /** The environment the call runs in: sandbox. */
  environment: string;
  /** oxagen:credential/<name>, as the environment resolved it. Undefined for operator-oauth with no service credential. */
  reference: string | undefined;
  /** The server's auth, with the scheme resolved. Never null here: a server with no auth asks for nothing. */
  auth: ManifestAuth;
  /** The person who runs the agent. Required for operator-oauth. */
  operator: string | undefined;
}

/** A credential a relay holds in its own environment (Enterprise). The relay adds it after it checks the envelope. */
export type RelayCredential = z.output<typeof relayCredentialSchema>;

/**
 * The secret for one call, or why there is none.
 *
 * - bearer: an access token (oauth2, openIdConnect, http_bearer).
 * - basic: http_basic.
 * - api_key: the key's value. The executor puts it where auth.apply.in and
 *   auth.apply.name say.
 * - relay: the relay adds the credential itself, so the executor sends none.
 * - missing: operator-oauth with no token for this operator. The executor
 *   returns isError with message and a link to connect_url, and sends
 *   nothing.
 */
export type ResolvedCredential =
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "api_key"; value: string }
  | { type: "relay"; credential: RelayCredential }
  | {
      type: "missing";
      /** The spec's text: "Connect your Billing API account in Oxagen, then retry." */
      message: string;
      connect_url: string;
    };

export interface CredentialSource {
  /**
   * Resolve the credential for one call. Rejects only when the vault or the
   * token endpoint fails. A missing operator token resolves to the missing
   * variant.
   */
  resolve(request: CredentialRequest, signal: AbortSignal): Promise<ResolvedCredential>;
}
