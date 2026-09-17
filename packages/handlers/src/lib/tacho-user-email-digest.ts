/**
 * The stored stand-in for the address of the person behind a Tacho session
 * (#3072), stamped by the control plane and by nothing else.
 *
 * ## Why a key, and not just a hash
 *
 * `tacho_events` has no ClickHouse row policy, so an ordinary org-scoped
 * analytics query can read this column. An email address carries so little
 * entropy that an UNKEYED hash of one is not a one-way function in practice:
 * that reader guesses `someone@their-own-company.com`, hashes it, and compares.
 * Domain-separating the hash does not help, because the domain string is
 * public — it sits in this file, in the ADR and in the migrations. It defeats a
 * generic precomputed table and nothing else, and the reader in this threat
 * model does not need one: they have their own staff directory.
 *
 * HMAC with a key that reader cannot obtain is what actually makes the value
 * one-way for them. The key lives in `TACHO_USER_EMAIL_DIGEST_KEY`, held by the
 * API deployment the same way `TACHO_ENROLLMENT_SIGNING_SECRET` is, and reaches
 * no tenant, no host and no store.
 *
 * ## Why the control plane and not the host
 *
 * Keying on the host would mean shipping the key to every host. Any one of them
 * could then reverse the digest of every colleague in its scope — a strictly
 * larger reach than the address in its own WAL, which is the machine's own
 * user's address on the machine's own disk. The control plane already holds
 * every other secret in this path, so keying here adds no new custodian.
 *
 * The host still hashes first where it can: a current collector sends
 * `anthropic.user_email_digest` and the address never crosses the wire at all.
 * This module keys whichever of the two pre-images arrives, so a legacy
 * collector and a current one produce the SAME stored value for one person.
 *
 * ## What stays true when the key is missing
 *
 * No digest is stored. The attribute is lost, the address is not leaked, and
 * ingestion keeps working — a missing key must not take a fleet's telemetry
 * down, which is the same failure shape as rejecting a legacy batch.
 */
import { createHmac } from "node:crypto";
import { digestUserEmail, type Sha256Digest } from "@oxagen/tacho";
import { logger } from "../logger";

export const USER_EMAIL_DIGEST_KEY_ENV = "TACHO_USER_EMAIL_DIGEST_KEY";

/**
 * Domain separator. It does no security work on its own — see the note above —
 * but it keeps this HMAC from colliding with any other use of the same key.
 */
const USER_EMAIL_HMAC_DOMAIN = "oxagen.tacho.user-email-digest.v1";

/**
 * The prefix is `hmac-sha256:` rather than `sha256:` so the stored value says
 * out loud that it is keyed. A reader who sees `sha256:` on a low-entropy
 * input is entitled to assume they can reverse it; on this column they cannot,
 * and the value should not invite the attempt.
 */
export type KeyedEmailDigest = `hmac-sha256:${string}`;

let warnedMissingKey = false;

function key(): Buffer | undefined {
  const secret = process.env[USER_EMAIL_DIGEST_KEY_ENV];
  if (secret === undefined || secret.length === 0) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      logger.warn(
        { env: USER_EMAIL_DIGEST_KEY_ENV },
        "tacho: no user-email digest key; sessions will record no person digest. " +
          "Ingestion continues and no address is stored.",
      );
    }
    return undefined;
  }
  return Buffer.from(secret, "utf8");
}

/** Reset the once-per-process warning. Tests only. */
export function resetUserEmailDigestWarningForTests(): void {
  warnedMissingKey = false;
}

/**
 * The unkeyed pre-image the host sends, or the one this computes from a legacy
 * address. Both spellings of the same person reduce to the same bytes, so the
 * keyed digest below does not depend on which member the collector sent.
 */
export function userEmailPreimage(anthropic: {
  user_email_digest?: string;
  user_email?: string;
}): Sha256Digest | undefined {
  if (anthropic.user_email_digest !== undefined) {
    return anthropic.user_email_digest as Sha256Digest;
  }
  return digestUserEmail(anthropic.user_email);
}

/**
 * HMAC-SHA256 over the domain and the pre-image. `undefined` when there is
 * nothing to digest, or when the deployment holds no key.
 */
export function keyedUserEmailDigest(
  preimage: Sha256Digest | undefined,
): KeyedEmailDigest | undefined {
  if (preimage === undefined) return undefined;
  const secret = key();
  if (secret === undefined) return undefined;
  const mac = createHmac("sha256", secret)
    .update(USER_EMAIL_HMAC_DOMAIN)
    .update("\0")
    .update(preimage)
    .digest("hex");
  return `hmac-sha256:${mac}`;
}

/** The whole path in one call: whichever member arrived, keyed, or nothing. */
export function stampUserEmailDigest(
  anthropic:
    | { user_email_digest?: string; user_email?: string }
    | undefined
    | null,
): KeyedEmailDigest | undefined {
  if (!anthropic) return undefined;
  return keyedUserEmailDigest(userEmailPreimage(anthropic));
}
