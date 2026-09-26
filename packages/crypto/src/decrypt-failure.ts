/**
 * Whether a `decrypt` failure will happen again on every later try, and how
 * far it reaches: every envelope under the key (`key`), or this one envelope
 * alone (`body`). Null means the failure may pass on a retry.
 *
 * Erasure destroys the key an envelope's data key was wrapped under and
 * leaves the ciphertext where it is (Mission Control spec §13.5). Every
 * later `decrypt` under that key then fails, and nothing a caller retries
 * will change that. A caller that caches failures needs to tell this apart
 * from a failure that may pass, such as a throttled or timed-out KMS call.
 * It also needs to know whether one failure says anything about the other
 * envelopes under the same key.
 *
 * `key`: AWS KMS says the key itself cannot be used. It is disabled
 * (`DisabledException`), pending deletion (`KMSInvalidStateException`), or
 * deleted (`NotFoundException`). Every envelope under it fails the same way.
 *
 * `body`: this envelope does not open, and the key may still open others.
 * KMS says the wrapped data key is damaged or was not wrapped by this key
 * (`InvalidCiphertextException`, `IncorrectKeyException`), or AES-GCM refuses
 * the tag while unwrapping the data key under a local key or while opening
 * the payload. Neither the key nor the bytes change between tries, so this
 * envelope fails the same way each time. A tag failure says the bytes were
 * damaged or tampered with, or that a local key was replaced. It cannot tell
 * those apart, so it answers for this envelope only.
 *
 * A disabled key can be enabled again. So "every later try" holds for as
 * long as the key stays as it is, and a caller should remember the answer
 * for a bounded time rather than for good.
 */
export type LastingDecryptFailure = "key" | "body";

const KMS_KEY_UNUSABLE: ReadonlySet<string> = new Set([
  "DisabledException",
  "KMSInvalidStateException",
  "NotFoundException",
]);

const KMS_CIPHERTEXT_REFUSED: ReadonlySet<string> = new Set([
  "InvalidCiphertextException",
  "IncorrectKeyException",
]);

/** The message Node's AES-GCM decipher throws when the tag does not verify. */
const GCM_TAG_REFUSED = "Unsupported state or unable to authenticate data";

export function lastingDecryptFailure(
  err: unknown,
): LastingDecryptFailure | null {
  if (!(err instanceof Error)) return null;
  if (KMS_KEY_UNUSABLE.has(err.name)) return "key";
  if (KMS_CIPHERTEXT_REFUSED.has(err.name) || err.message === GCM_TAG_REFUSED)
    return "body";
  return null;
}
