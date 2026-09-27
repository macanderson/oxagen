// relay-envelope.ts: `relay-envelope/v1`, one request the cloud gateway
// decided and signed for a relay inside a private network (mcp-studio-spec,
// Relay rules).
//
// The envelope names the exact scheme, method, host, and path, or the exact
// gRPC service and method. The request's headers, or a gRPC call's metadata,
// and its body travel beside it, bound by headers_hash and body_hash, so a
// broker cannot downgrade the scheme or change a header without breaking the
// signature. The relay refuses an envelope that is unsigned, expired,
// replayed, or aimed at a host its own allowlist does not name, and a request
// whose headers or body hash to anything else.
import type { Sha256Digest } from "@oxagen/run-evidence";
import { z } from "zod";
import { sha256Schema } from "@oxagen/oxagen/steering-repo/common";
import { CREDENTIAL_NAME_PATTERN } from "@oxagen/oxagen/steering-repo/names";
import { withChecks } from "./checks";
import {
  envelopeDeadlineSchema,
  envelopeSignatureSchema,
  expiresAtSchema,
  expiryCheck,
  issuedAtSchema,
  nonceSchema,
} from "./envelope";
import { canonicalDigest } from "./json";
import {
  headerNameSchema,
  hostSchema,
  httpMethodSchema,
  portSchema,
  protoFullNameSchema,
  RELAY_NAME_PATTERN,
} from "./primitives";

const relaySchemeSchema = z
  .enum(["https", "http"])
  .describe("https, or http when the environment's url says so. gRPC over http is cleartext HTTP/2.");

const relayPortSchema = portSchema
  .optional()
  .describe("Omitted for the scheme's default port: 443 for https, 80 for http.");

export const relayHttpTargetSchema = z
  .object({
    kind: z.literal("http"),
    scheme: relaySchemeSchema,
    method: httpMethodSchema,
    host: hostSchema,
    port: relayPortSchema,
    path: z
      .string()
      .max(8192)
      .regex(/^\/[^\s#]*$/, "a path starts with / and has no spaces or fragment")
      .describe("The path and query string, percent-encoded, exactly as the relay sends them."),
  })
  .strict()
  .describe("An HTTP request, including an MCP streamable HTTP request.");

export const relayGrpcTargetSchema = z
  .object({
    kind: z.literal("grpc"),
    scheme: relaySchemeSchema,
    host: hostSchema,
    port: relayPortSchema,
    service: protoFullNameSchema.describe("The full service name, such as a_intel.ledger.v1.Ledger."),
    method: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a gRPC method name is one identifier")
      .describe("The method name, such as PostEntry."),
  })
  .strict()
  .describe("One gRPC call.");

export const relayTargetSchema = z.union([relayHttpTargetSchema, relayGrpcTargetSchema]);
export type RelayTarget = z.output<typeof relayTargetSchema>;

/**
 * An envelope's headers_hash: SHA-256 over the RFC 8785 form of the request's
 * headers, or a gRPC call's metadata, as a list of [name, value] pairs in the
 * order they are sent, with each name in lowercase. No headers hash as the
 * empty list. The relay broker computes it when the gateway signs, and the
 * relay computes it again from the headers it received. A credential the relay
 * adds itself comes after the check, so it is not in the list.
 */
export function relayHeadersHash(entries: readonly (readonly [name: string, value: string])[]): Sha256Digest {
  return canonicalDigest(entries.map(([name, value]) => [name.toLowerCase(), value]));
}

/** A credential the relay holds itself (Enterprise) and adds after it checks the envelope. */
export const relayCredentialSchema = withChecks(
  z
    .object({
      name: z
        .string()
        .regex(CREDENTIAL_NAME_PATTERN, "not a credential name")
        .describe("The credential's name in the relay's own store."),
      scheme: z.enum(["bearer", "basic", "header"]),
      header: headerNameSchema.optional(),
    })
    .strict()
    .describe("A customer-held credential the relay adds to the request."),
  [
    { kind: "require", when: { field: "scheme", is: "header" }, fields: ["header"] },
    { kind: "forbid", when: { field: "scheme", isNot: "header" }, fields: ["header"] },
  ],
);

export const relayEnvelopeSchema = withChecks(
  z
    .object({
      schema: z.literal("relay-envelope/v1"),
      relay: z
        .string()
        .regex(RELAY_NAME_PATTERN, "not a relay name")
        .describe("The relay this envelope is for, as network = relay:<name> names it."),
      nonce: nonceSchema,
      issued_at: issuedAtSchema,
      expires_at: expiresAtSchema,
      target: relayTargetSchema,
      headers_hash: sha256Schema.describe(
        "SHA-256 over the RFC 8785 form of the headers, or the gRPC metadata, as [name, value] pairs in the order " +
          "they are sent, each name in lowercase. No headers hash as []. A credential the relay adds is not included.",
      ),
      body_hash: sha256Schema.describe(
        "SHA-256 of the exact request body bytes. An empty body hashes the empty string.",
      ),
      deadline_ms: envelopeDeadlineSchema.describe("How long the relay waits for the response. 30000 when omitted."),
      credential: relayCredentialSchema.optional(),
      signature: envelopeSignatureSchema,
    })
    .strict()
    .describe("One request the cloud gateway decided and signed for a relay."),
  [expiryCheck],
);
export type RelayEnvelope = z.output<typeof relayEnvelopeSchema>;
