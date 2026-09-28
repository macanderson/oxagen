// envelope.ts: the cloud gateway signs one local call into a
// local-call-envelope/v1 (mcp-studio-spec, Local servers).
//
// The envelope binds the call to the tool's locked version and definition
// hash, the package digest, a hash of the arguments, one machine, a nonce,
// and an expiry a few seconds out. The local gateway runs the call only on an
// envelope that verifies, so it keeps no decision and no policy of its own.
import { randomBytes } from "node:crypto";
import {
  canonicalDigest,
  envelopeSigningBytes,
  localCallEnvelopeSchema,
  type LocalCall,
  type LocalCallEnvelope,
} from "@oxagen/mcp-studio";
import type { LocalCallSigner } from "./signer";

/**
 * How long an envelope stays valid after the cloud gateway signs it. The
 * local gateway long-polls for calls, so it receives one within a second of
 * the signature. The ten seconds leave room for clock skew and a slow pull.
 */
export const LOCAL_CALL_TTL_MS = 10_000;

/** 16 random bytes, 128 bits, in base64url: 22 characters. */
export function newNonce(): string {
  return randomBytes(16).toString("base64url");
}

export interface SignLocalCallInput {
  call: Omit<LocalCall, "signal">;
  /** The machine that may run the call: its tacho.hosts public id. */
  machine: string;
  signer: LocalCallSigner;
  now?: Date;
  nonce?: string;
  ttlMs?: number;
}

/**
 * Sign one call. The envelope is checked against M0's local-call-envelope/v1
 * schema before it is returned, so a call that schema refuses throws here
 * and never reaches a machine.
 */
export function signLocalCall(input: SignLocalCallInput): LocalCallEnvelope {
  const issued = input.now ?? new Date();
  const unsigned = {
    schema: "local-call-envelope/v1" as const,
    tool: input.call.tool,
    upstream: input.call.upstream,
    version: input.call.version,
    definition_hash: input.call.definition_hash,
    package_digest: input.call.package_digest,
    arguments_hash: canonicalDigest(input.call.arguments),
    deadline_ms: input.call.deadline_ms,
    machine: input.machine,
    nonce: input.nonce ?? newNonce(),
    issued_at: issued.toISOString(),
    expires_at: new Date(issued.getTime() + (input.ttlMs ?? LOCAL_CALL_TTL_MS)).toISOString(),
  };
  const envelope = {
    ...unsigned,
    signature: {
      key_id: input.signer.keyId,
      alg: "ed25519" as const,
      sig: input.signer.sign(envelopeSigningBytes(unsigned)),
    },
  };
  return localCallEnvelopeSchema.parse(envelope);
}
