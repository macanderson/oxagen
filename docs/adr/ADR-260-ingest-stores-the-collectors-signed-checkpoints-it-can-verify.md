# ADR-260: Ingest stores the collector's signed checkpoints it can verify

- **Status:** Accepted. The agent building the tacho-checkpoints lane chose
  this. Mac has not ruled on it. Issue #3406 asked for this decision and
  proposed the write in ingest.
- **Date:** 2026-10-02
- **Owners:** tacho, evidence
- **Related:** issue #3406, issue #3370 (where the gap was found), ADR-179,
  ADR-195, ADR-231, `docs/specs/tacho/design/trace-model.md` section 2,
  `docs/specs/tacho/data-model.md` section 3.8.

## Context

About once a minute, `tachod` seals a `checkpoint` frame on each session
chain that moved (`checkpoint` in `packages/tacho/src/collector/daemon.ts`).
The frame carries four facts in its body:

- `checkpoint_event_count`: the number of frames under the checkpoint.
- `checkpoint_chain_head`: the hash of the last of those frames.
- `checkpoint_device_signature`: an Ed25519 signature by the host's device
  key over `<session uuid>:<last covered seq>:<chain head>`.
- `checkpoint_device_key_fingerprint`: the first 16 hex characters of the
  SHA-256 of the host's encoded public key.

`get_run_chain` and `get_tacho_session` read `tacho.checkpoints`. Nothing
wrote it. Every wrapped session answered
`checkpoints: []` and `checkpointCount: 0`, even when its host had signed
checkpoints. The frames themselves reached ClickHouse `tacho_events`, which
has a column for each of the four facts.

Two places could supply the read:

1. Ingest writes a `tacho.checkpoints` row when a `checkpoint` frame arrives.
2. The reads derive checkpoints from the frames in `tacho_events`.

## Decision

1. **Ingest writes the row.** `ingest_tacho_events` calls
   `recordCheckpoints` (`packages/handlers/src/lib/tacho-checkpoints.ts`)
   inside the tenant transaction, beside the model, file, and command
   rollups. It runs only on a batch the session row accepted, over the frames
   past the session's recorded head. Row-level security fences the write to
   the batch's organization and workspace, like every other ingest write.
2. **Every row is verified at ingest.** A frame becomes a row only when all
   of these hold:
   - Each of the four members is present and well formed, and the chain head
     matches the column's CHECK constraint.
   - The count equals the frame's own `seq`, and the chain head equals the
     frame's `prev_hash`. The collector seals the checkpoint straight after
     the frames it covers, so a frame that says otherwise signs some other
     chain.
   - The fingerprint names the device key the host enrolled with.
   - The signature verifies under that key.
3. **A frame that fails is left out, and the batch is still accepted.**
   Ingest logs a warning with the session and the reason. There is no row
   marked unverified. So `get_run_chain` never shows an unchecked signature,
   and the table needs no new column. The frame still reaches `tacho_events`
   as the host sent it.
4. **The row's `seq` is the last frame the checkpoint covers.** That is the
   sequence the device signed, so anyone can verify a row again from its own
   columns, the session uuid, and the host's public key. `event_count` is
   `seq + 1`.
5. **A retried batch writes no second row.** Ingest writes only frames past
   the recorded head, and the INSERT skips a row the `(session_id, seq)`
   unique index already holds.
6. **A checkpoint is kept even when the batch's hash chain does not verify.**
   The row says the device key signed head X at sequence N. That stays true
   when the stored frames disagree, and an auditor needs the signed head to
   show where they disagree. The chain break is already recorded on the
   session row.
7. **The control plane does not countersign yet.** The trace model says the
   control plane countersigns on ingest. No platform key is scoped to
   checkpoints. The bundle key signs policy bundles (spec section 7.1), and
   the attester key signs seal attestations (ADR-195). Reusing either widens
   what that key vouches for, and a new key needs a production secret. Until
   one exists, `platform_key_id`, `platform_signature`, and `countersigned_at`
   stay null, which the `get_run_chain` contract already allows.

## Why not derive the checkpoints from the frames

- **The frames expire.** `tacho_events` keeps a frame for
  `TACHO_EVENTS_RETENTION_MONTHS` (`framesMayHaveExpired` in
  `run.chain.get.ts`). An old run is the one an auditor most needs to check,
  and its checkpoints would be gone with its frames. A Postgres row has no
  expiry.
- **Verification needs the enrolled key.** The key lives on the
  `tacho.hosts` row that ingest already reads. A derived read would verify
  every signature on every request, or show signatures nobody verified.
- **The reads already exist.** `get_run_chain` and `get_tacho_session`
  read Postgres and stay unchanged.

## Consequences

- `get_run_chain` lists real checkpoints for a wrapped session, and its
  unsealed `merkleRoot` names the newest checkpoint's chain head.
  `get_tacho_session` counts them.
- A session recorded before this change keeps no rows. Its frames in
  `tacho_events` still carry the checkpoint columns, so a backfill could add
  them while the frames last. None is planned.
- `tacho.sessions.checkpoint_count` and `last_checkpoint_id` stay unwritten.
  Every reader counts the rows instead, so the columns are not a second
  record that can drift.
- Verification is one Ed25519 check per checkpoint frame, on the API node.
  It adds nothing to the daemon's hook path (ADR-231).
- A host whose device key file was replaced without re-enrolling has every
  checkpoint left out, and a warning in the API log names its sessions.
- A successor host shares its predecessor's device key (ADR-179), so the
  successor's key verifies frames either one sealed.
- To reverse: remove the `recordCheckpoints` call from ingest. The rows
  already written stay valid, because each one verifies from its own
  columns.
