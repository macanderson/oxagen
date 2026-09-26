/**
 * The run attestation a seal writes (spec §8.3, #4000, ADR-195).
 *
 * A seal signs its own figures when it is written: the run and attempt, the
 * frame count, the Merkle root, the digest of the archive segment as stored,
 * the enforcement tier, the completeness gaps and the replay grade. The
 * signature and the key id that made it are stored on the seal row once, and
 * nothing updates them. `get_run_chain` reads them back, and `export_run`
 * ships the same signature when the key that made it is still the
 * deployment's key.
 *
 * The key is `TACHO_BUNDLE_SIGNING_PRIVATE_KEY`, the one the export signs
 * with. It is resolved at seal time, the way `deferredEvidenceArchive`
 * resolves the archive, so a module that builds a run store at load time
 * reads the key only when it seals.
 */
import {
  type AttestationPayload,
  attesterKeyFromPem,
  type AttesterKey,
  signAttestation,
} from "@oxagen/tacho";

/** The deployment's attester key, the same variable `export_run` reads. */
export const ATTESTER_KEY_ENV = "TACHO_BUNDLE_SIGNING_PRIVATE_KEY";

/**
 * The key parsed from the variable's value, kept per process. It is keyed by
 * that value, so a process whose variable changes parses the new key rather
 * than signing with the old one.
 */
let cached: { raw: string; key: AttesterKey | null } | undefined;

/**
 * The process-wide attester key, or null when none is configured.
 *
 * A value that is not an Ed25519 PKCS#8 key is logged once and answers null.
 * The seal then carries no attestation and still commits: refusing it would
 * leave the run open, which is the failure ADR-180 closes. A null signature
 * reads "not recorded" on the Chain tab and in `oxagen run chain`, so the
 * missing key is visible there.
 */
export function deferredAttester(): AttesterKey | null {
  const raw = process.env[ATTESTER_KEY_ENV];
  if (raw === undefined || raw === "") return null;
  if (cached?.raw === raw) return cached.key;
  let key: AttesterKey | null = null;
  try {
    key = attesterKeyFromPem(raw.replace(/\\n/g, "\n"));
  } catch (err) {
    console.error(
      `[run-ledger] ${ATTESTER_KEY_ENV} is set but is not an Ed25519 private key, so seals are written without an attestation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  cached = { raw, key };
  return key;
}

/** What a seal signs, in the words the seal row and the export use. */
export interface SealAttestationFigures {
  /** The run's public id (`arun_…`). */
  runPublicId: string;
  /** The attempt's public id (`arat_…`). */
  attemptPublicId: string;
  /** Every frame the archive segment holds. */
  frameCount: number;
  merkleRoot: string;
  /** sha256 over the archive segment's bytes as stored. */
  archiveSegmentDigest: string;
  enforcementTier: string;
  /** In the order the seal writes them. */
  completenessGaps: readonly string[];
  replayGrade: string | null;
}

/** The three seal columns an attestation fills. */
export interface SealAttestationColumns {
  /** Written on every seal, signed or not. */
  archiveSegmentDigest: string;
  /** Null together when the seal was written with no attester key. */
  attestationKeyId: string | null;
  attestationSig: string | null;
}

/** The attestation payload over a seal's figures (`AttestationPayload`). */
export function sealAttestationPayload(
  figures: SealAttestationFigures,
): AttestationPayload {
  return {
    run_id: figures.runPublicId,
    attempt_id: figures.attemptPublicId,
    frame_count: figures.frameCount,
    merkle_root: figures.merkleRoot,
    archive_segment_digest: figures.archiveSegmentDigest,
    enforcement_tier: figures.enforcementTier,
    completeness_gaps: [...figures.completenessGaps],
    replay_grade: figures.replayGrade,
  };
}

/**
 * The columns a seal writes: the segment digest always, and the key id and
 * signature when a key is configured. With no key both are null, so the
 * seal still commits and a reader says the signature was not recorded.
 */
export function signSealAttestation(
  key: AttesterKey | null,
  figures: SealAttestationFigures,
): SealAttestationColumns {
  if (key === null) {
    return {
      archiveSegmentDigest: figures.archiveSegmentDigest,
      attestationKeyId: null,
      attestationSig: null,
    };
  }
  const attestation = signAttestation(sealAttestationPayload(figures), key);
  return {
    archiveSegmentDigest: figures.archiveSegmentDigest,
    attestationKeyId: attestation.key_id,
    attestationSig: attestation.sig,
  };
}
