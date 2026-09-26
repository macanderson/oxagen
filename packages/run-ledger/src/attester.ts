/**
 * The process-wide attester key a seal is signed with (#4000). It is resolved
 * at seal time, the way `deferredEvidenceArchive` resolves the archive, so a
 * module that builds a run store at load time pays for the key only when it
 * seals.
 *
 * It reads `TACHO_BUNDLE_SIGNING_PRIVATE_KEY`, the key the run export signs
 * with, and caches it per process. No key configured answers null, and the
 * seal is written with null attestation columns.
 */
import type { AttesterKey } from "@oxagen/tacho";

/**
 * The Archive and replay lane writes the read and the cache (#4000). Until
 * then it refuses, and no run store is built with it.
 */
export function deferredAttester(): AttesterKey | null {
  throw new Error("deferredAttester: not implemented (#4000)");
}
