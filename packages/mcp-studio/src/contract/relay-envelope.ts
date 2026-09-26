// relay-envelope.ts: `relay-envelope/v1`, one request the cloud gateway
// decided and signed for a relay inside a private network (mcp-studio-spec,
// Relay rules).
//
// The envelope names the exact method, host, and path, or the exact gRPC
// service and method. The request body travels beside it and is bound by
// body_hash. The relay refuses an envelope that is unsigned, expired,
// replayed, or aimed at a host its own allowlist does not name.
import { z } from "zod";
import { sha256Schema } from "@oxagen/oxagen/steering-repo/common";
import { CREDENTIAL_NAME_PATTERN } from "@oxagen/oxagen/steering-repo/names";
import { withChecks } from "./checks";
import {
  envelopeSignatureSchema,
  expiresAtSchema,
  expiryCheck,
  issuedAtSchema,
  nonceSchema,
} from "./envelope";
import {
  headerNameSchema,
  hostSchema,
  httpMethodSchema,
  portSchema,
  protoFullNameSchema,
  RELAY_NAME_PATTERN,
} from "./primitives";

export const relayHttpTargetSchema = z
  .object({
    kind: z.literal("http"),
    method: httpMethodSchema,
    host: hostSchema,
    port: portSchema.optional().describe("Omitted for 443."),
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
    host: hostSchema,
    port: portSchema.optional().describe("Omitted for 443."),
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
      body_hash: sha256Schema.describe(
        "SHA-256 of the exact request body bytes. An empty body hashes the empty string.",
      ),
      deadline_ms: z
        .number()
        .int()
        .min(1)
        .max(300_000)
        .optional()
        .describe("How long the relay waits for the response. 30000 when omitted."),
      credential: relayCredentialSchema.optional(),
      signature: envelopeSignatureSchema,
    })
    .strict()
    .describe("One request the cloud gateway decided and signed for a relay."),
  [expiryCheck],
);
export type RelayEnvelope = z.output<typeof relayEnvelopeSchema>;
