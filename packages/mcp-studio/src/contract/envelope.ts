// envelope.ts: what the relay envelope and the local call envelope share.
//
// The cloud gateway signs every call it decided. The relay and the local
// gateway act only on an envelope whose signature checks, whose expiry has
// not passed, and whose nonce they have not seen (mcp-studio-spec, Network
// paths and Local servers). The signature covers the RFC 8785 bytes of the
// envelope without its `signature` field.
import { z } from "zod";
import { instantSchema } from "@oxagen/oxagen/steering-repo/common";
import { canonicalBytes } from "./json";
import type { CustomCheck } from "./checks";

/** The longest an envelope may live: "an expiry a few seconds out". */
export const ENVELOPE_TTL_MAX_MS = 30_000;

/** A single-use value. The receiver refuses one it has seen before the expiry passes. */
export const nonceSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{22,64}$/, "a nonce is 22 to 64 base64url characters")
  .describe("A single-use value, at least 128 bits of randomness in base64url.");

export const envelopeSignatureSchema = z
  .object({
    key_id: z
      .string()
      .regex(/^[0-9a-f]{16}$/, "a key id is 16 lowercase hex characters")
      .describe("The first 8 bytes of the SHA-256 of the signing public key, in hex."),
    alg: z.literal("ed25519"),
    sig: z
      .string()
      .regex(/^[A-Za-z0-9+/]{86}==$/, "an Ed25519 signature is 64 bytes in padded base64")
      .describe("The signature over the envelope's RFC 8785 bytes without its signature field."),
  })
  .strict()
  .describe("The cloud gateway's signature.");
export type EnvelopeSignature = z.output<typeof envelopeSignatureSchema>;

export const issuedAtSchema = instantSchema.describe("When the cloud gateway signed the envelope.");
export const expiresAtSchema = instantSchema.describe(
  `When the envelope stops being valid: after issued_at, and at most ${ENVELOPE_TTL_MAX_MS / 1000} seconds after it.`,
);

/**
 * expires_at is after issued_at and at most ENVELOPE_TTL_MAX_MS later. JSON
 * Schema cannot compare two dates, so only zod checks it.
 */
export const expiryCheck: CustomCheck = {
  json: undefined,
  issues(value) {
    const issued = Date.parse(String(value.issued_at));
    const expires = Date.parse(String(value.expires_at));
    if (Number.isNaN(issued) || Number.isNaN(expires)) return [];
    if (expires <= issued) {
      return [{ path: ["expires_at"], message: "expires_at must be after issued_at" }];
    }
    if (expires - issued > ENVELOPE_TTL_MAX_MS) {
      return [
        {
          path: ["expires_at"],
          message: `expires_at must be at most ${ENVELOPE_TTL_MAX_MS / 1000} seconds after issued_at`,
        },
      ];
    }
    return [];
  },
};

/** The bytes the cloud gateway signs: the envelope's RFC 8785 form without `signature`. */
export function envelopeSigningBytes(envelope: Record<string, unknown>): Uint8Array {
  const { signature: _signature, ...signed } = envelope;
  return canonicalBytes(signed);
}
