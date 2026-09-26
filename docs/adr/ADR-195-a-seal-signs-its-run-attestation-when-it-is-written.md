# ADR-195: A seal signs its run attestation when it is written

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** platform
- **Amends:** ADR-058 (the seal and the export bundle), the export half of
  spec §13.4.
- **Related:** ADR-043 (Oxagen runs no agent, so the seal is the fence),
  ADR-180 (the idle close seals a silent attempt), issue #4000.

## Context

A ledger seal commits to an attempt's frames three ways: the event stream
digest, the Merkle root over the frame digests, and the archive segment it
writes before the seal row (spec §13.3). The run attestation (spec §8.3) is
the Ed25519 signature over those figures, and until this decision only
`export_run` made one, when a person asked for a bundle.

That left three defects.

- The Run page's Seal and attestation panel had no signature to show. It drew
  "not recorded" in the Signature and Signs over rows, because the seal row
  held none.
- The seal computed the archive segment's digest and threw it away, so
  nothing on the seal named the bytes the attestation signs.
- The export signed every ledger attempt at the `harness` tier, whatever the
  seal recorded. A gateway run's seal graded under `gateway` and its export
  signed `harness`. The seal and the bundle disagreed about the same attempt.

An attestation made at export time also attests the export's reading of the
record, weeks after the seal, and not what the seal committed to when it was
written.

## Decision

### 1. Signing at seal time

`sealAttemptInTx` signs the attempt's figures in the same transaction that
writes the seal row. The payload is `AttestationPayload`, the eight fields
`RUN_ATTESTATION_FIELDS` names, in the words the export uses:

| Field | Value |
|---|---|
| `run_id` | the run's public id (`arun_…`), the id the export signs |
| `attempt_id` | the attempt's public id (`arat_…`) |
| `frame_count` | the frames the archive segment holds |
| `merkle_root` | the RFC 6962 root over the frame digests |
| `archive_segment_digest` | sha256 over the segment's bytes as stored |
| `enforcement_tier` | the tier the seal graded under |
| `completeness_gaps` | the gaps the seal records, in the order it writes them |
| `replay_grade` | the grade the seal records |

The design of record lists seven fields and leaves out `replay_grade`. The
build names the eight the payload signs.

### 2. The key

The key is the deployment's attester key, `TACHO_BUNDLE_SIGNING_PRIVATE_KEY`,
the one `export_run` already signs with. `deferredAttester` in
`@oxagen/run-ledger` reads it when a seal is written, never when a store is
built, and keeps the parsed key per process, keyed by the variable's value.
The stores that seal pass it: the durable jobs' `ledgerStore` (the idle close
and the abandon sweep), the in-app assistant's store, and the e2e seed.

### 3. Sealing without a key

A deployment with no key, or with a value that is not an Ed25519 private key,
seals with a null key id and signature. The seal still commits. Refusing it
would leave the run open, the failure ADR-180 closes. A bad value is logged
once per process by the variable's name, never its value. The Chain tab and
`oxagen run chain` say the signature was not recorded, so a missing key is
visible where the signature would be.

### 4. The seal row

The seal row gains three nullable text columns, written once with the row:
`archive_segment_digest`, `attestation_key_id` and `attestation_sig` (base64).
The app role still has no UPDATE on the table, so the row stays immutable.
`agent_run_attempt_seals_attestation_check` holds that the key id and the
signature are null together, that a signature has a segment digest, that a
segment digest has a segment reference, and that the digest is a sha256.

### 5. No backfill

A seal written before this decision stays unsigned. Signing it now would
attest figures the seal never signed, at a time it was not written.

### 6. The chain read

`get_run_chain` answers each seal's `archiveSegmentDigest` and
`attestation: { alg, keyId, sig, signsOver }`. The payload's values are the
seal's own fields, so the attestation names them and carries no copy. A seal
with no signature, and a key id without its signature, answer null. A
wrapped session has no seal row, and its seal answers null for both.

### 7. The export

`export_run` signs at the tier the seal recorded. A seal from before the tier
column reads as `harness`, which is what it was graded under.

When a seal's key id is the deployment's current key id, the bundle ships the
seal's own signature over the figures the export recomputes from the stored
segment, and signs nothing new. Ed25519 is deterministic, so that signature
verifies exactly when the figures match what the seal signed. A segment or a
seal row changed after the seal fails the verifier. Re-signing on a mismatch
would hide that, so the export never does.

A seal signed by a key the deployment has since rotated away from, a seal
written unsigned, and a wrapped session are signed with the current key when
the bundle is built, as before. `verify.mjs` and `oxagen verify` are
unchanged.

## Consequences

- The Seal and attestation panel shows the key and the signature, and a
  retried run shows each attempt's own.
- A seal and its export sign the same figures at the same tier.
- A compacted attempt is as verifiable as a hot one: the segment's bytes hash
  to the digest the seal stored, and the seal's signature verifies over
  figures a reader recomputes from the segment alone
  (`packages/run-ledger/src/compacted-read.test.ts`).
- Signing adds one Ed25519 signature per seal, well under a millisecond, and
  under 200 bytes to the seal row: an 88-character signature, a 16-character
  key id and a 71-character digest.
- A rotated key leaves older seals signed by a key id the deployment no longer
  holds. Their export is signed by the current key. Checking the original
  signature needs the retired public key, which Oxagen does not publish yet.
- The migration adds the three columns with no backfill. The
  `migration-required` label applies it on merge (SCR-006).

## Alternatives considered

- **Sign only at export.** This is where the code stood. The seal and the
  bundle could disagree, and nothing on the Run page could show a signature.
- **Refuse to seal without a key.** A misconfigured deployment would strand
  every run open.
- **Sign later, in a job.** It needs an UPDATE on an immutable seal row, or a
  second table that a reader has to join to learn whether a seal was ever
  signed.
- **Store the whole signed payload.** Every value is already a seal column.
  A copy could drift from the row it describes.
