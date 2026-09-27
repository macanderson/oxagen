/**
 * The checks the local gateway runs on a call's local-call-envelope/v1
 * before it starts anything (mcp-studio-spec, Local servers).
 *
 * The cloud gateway decides a call and signs the envelope with the key
 * enrollment gave this machine. The local gateway trusts nothing else in the
 * delivery: the launch travels unsigned, so its package digest must equal the
 * one the envelope signs, and the arguments must hash to the envelope's
 * arguments_hash. The checks run in a fixed order, and the nonce is recorded
 * only when every other check passes, so a refused envelope can be fixed and
 * sent again under the same nonce.
 */
import { createPublicKey, verify } from "node:crypto";
import { keyIdForPublicKey } from "../../host/key-id";
import {
  argumentsMismatch,
  envelopeExpired,
  envelopeInvalid,
  envelopeReplayed,
  launchMismatch,
  wrongMachine,
  type LocalServerRefusal,
} from "./errors";
import type { NonceLedger } from "./nonces";
import {
  argumentsHashOf,
  ENVELOPE_TTL_MAX_MS,
  envelopeSigningBytes,
  type CallDelivery,
} from "./wire";

/** How far this machine's clock may drift from the cloud gateway's. */
export const DEFAULT_CLOCK_SKEW_MS = 5_000;

export interface VerifyCallOptions {
  /** This machine's id: tacho.hosts' public id, from the host file's host_enrollment_id. */
  machine: string;
  /** The signing key's public half, from the host file's bundle_public_key_pem. */
  publicKeyPem: string;
  nonces: NonceLedger;
  /** The time now, in epoch milliseconds. */
  now: number;
  skewMs: number;
}

export type EnvelopeCheck = { ok: true } | { ok: false; refusal: LocalServerRefusal };

function refuse(refusal: LocalServerRefusal): EnvelopeCheck {
  return { ok: false, refusal };
}

function signatureVerifies(delivery: CallDelivery, publicKeyPem: string): boolean {
  try {
    return verify(
      null,
      envelopeSigningBytes(delivery.envelope),
      createPublicKey(publicKeyPem),
      Buffer.from(delivery.envelope.signature.sig, "base64"),
    );
  } catch {
    return false;
  }
}

/** Run every envelope check on a call, in order, and record its nonce when all pass. */
export function verifyCallDelivery(delivery: CallDelivery, options: VerifyCallOptions): EnvelopeCheck {
  const { envelope } = delivery;
  const { signature } = envelope;

  if (signature.alg !== "ed25519") {
    return refuse(envelopeInvalid(`it is signed with ${String(signature.alg)}, and this machine accepts only ed25519`));
  }
  const trusted = keyIdForPublicKey(options.publicKeyPem);
  if (signature.key_id !== trusted) {
    return refuse(envelopeInvalid(`it names signing key ${signature.key_id}, and this machine trusts key ${trusted}`));
  }
  if (!signatureVerifies(delivery, options.publicKeyPem)) {
    return refuse(envelopeInvalid("the signature does not match its contents"));
  }

  if (envelope.machine !== options.machine) return refuse(wrongMachine(envelope.machine));

  const issued = Date.parse(envelope.issued_at);
  const expires = Date.parse(envelope.expires_at);
  if (Number.isNaN(issued) || Number.isNaN(expires) || expires <= issued) {
    return refuse(envelopeInvalid("its expires_at is not later than its issued_at"));
  }
  if (issued > options.now + options.skewMs) {
    return refuse(envelopeInvalid(`it was issued at ${envelope.issued_at}, later than this machine's clock allows`));
  }
  // An envelope never lives past the TTL cap, whatever its expires_at says.
  const lapses = Math.min(expires, issued + ENVELOPE_TTL_MAX_MS);
  if (options.now > lapses + options.skewMs) {
    return refuse(envelopeExpired(new Date(lapses).toISOString()));
  }

  if (delivery.launch.package.digest !== envelope.package_digest) {
    return refuse(
      launchMismatch(
        `the launch pins package digest ${delivery.launch.package.digest}, and the envelope signs ${envelope.package_digest}`,
      ),
    );
  }
  if (argumentsHashOf(delivery.arguments) !== envelope.arguments_hash) {
    return refuse(argumentsMismatch());
  }

  if (options.nonces.seen(envelope.nonce, options.now)) return refuse(envelopeReplayed());
  options.nonces.remember(envelope.nonce, lapses, options.now);
  return { ok: true };
}
