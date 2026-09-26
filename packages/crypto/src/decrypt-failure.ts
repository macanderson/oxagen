/**
 * Whether a `decrypt` failure will happen again on every later try.
 *
 * Erasure destroys the key an envelope's data key was wrapped under and
 * leaves the ciphertext where it is (Mission Control spec §13.5). Every
 * later `decrypt` of that envelope then fails, and nothing a caller retries
 * will change that. A caller that caches failures needs to tell this apart
 * from a failure that may pass, such as a throttled or timed-out KMS call.
 *
 * Two kinds of failure answer true:
 *
 * - AWS KMS says the key cannot be used: it is disabled
 *   (`DisabledException`), pending deletion (`KMSInvalidStateException`),
 *   deleted (`NotFoundException`), or not the key that wrapped this data key
 *   (`InvalidCiphertextException`, `IncorrectKeyException`).
 * - AES-GCM refuses the tag, while unwrapping the data key under a local key
 *   or while opening the payload. Neither the key nor the bytes change
 *   between tries, so the tag fails the same way each time.
 *
 * A disabled key can be enabled again. So "every later try" holds for as
 * long as the key stays as it is, and a caller should remember the answer
 * for a bounded time rather than for good.
 */
const KMS_KEY_UNUSABLE: ReadonlySet<string> = new Set([
  "DisabledException",
  "KMSInvalidStateException",
  "NotFoundException",
  "InvalidCiphertextException",
  "IncorrectKeyException",
]);

/** The message Node's AES-GCM decipher throws when the tag does not verify. */
const GCM_TAG_REFUSED = "Unsupported state or unable to authenticate data";

export function isLastingDecryptFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return KMS_KEY_UNUSABLE.has(err.name) || err.message === GCM_TAG_REFUSED;
}
