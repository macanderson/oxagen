// local-call-envelope.ts: `local-call-envelope/v1`, one call to a local
// server that the cloud gateway decided and signed (mcp-studio-spec, Local
// servers).
//
// The local gateway runs the call only when the envelope's signature checks,
// its expiry has not passed, its nonce is new, the arguments it received hash
// to arguments_hash, the tool's locked version matches, and the command's
// package digest matches the lock. It keeps no cached decisions.
import { z } from "zod";
import { sha256Schema, toolNameSchema } from "@oxagen/oxagen/steering-repo/common";
import { withChecks } from "./checks";
import {
  envelopeSignatureSchema,
  expiresAtSchema,
  expiryCheck,
  issuedAtSchema,
  nonceSchema,
} from "./envelope";
import { upstreamToolNameSchema } from "./primitives";

export const localCallEnvelopeSchema = withChecks(
  z
    .object({
      schema: z.literal("local-call-envelope/v1"),
      tool: toolNameSchema.describe("The tool the agent called, such as files__read_file."),
      upstream: upstreamToolNameSchema.describe("The name the local server knows the tool by."),
      version: z.number().int().min(1).describe("The tool's version in the lock."),
      definition_hash: sha256Schema.describe("The tool's definition hash in the lock."),
      package_digest: sha256Schema.describe(
        "The lock's digest of the package or binary. The local gateway refuses a command that does not match.",
      ),
      arguments_hash: sha256Schema.describe(
        "SHA-256 over the RFC 8785 form of the upstream arguments, after the input was shaped.",
      ),
      machine: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,64}$/, "not a machine id")
        .describe("The enrolled machine the call may run on."),
      nonce: nonceSchema,
      issued_at: issuedAtSchema,
      expires_at: expiresAtSchema,
      signature: envelopeSignatureSchema,
    })
    .strict()
    .describe("One call to a local server that the cloud gateway decided and signed."),
  [expiryCheck],
);
export type LocalCallEnvelope = z.output<typeof localCallEnvelopeSchema>;
