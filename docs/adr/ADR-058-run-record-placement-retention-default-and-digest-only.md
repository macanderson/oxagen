# ADR-058: Run record placement, retention default and `digest_only`

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** platform
- **Related:** issue #2952 (run recorder and replay), issue #2955 (the
  witness, which reads the grade this ADR defines), ADR-042 (data planes),
  ADR-043 (Oxagen governs agents and does not run them), Mission Control
  spec §8.2–§8.4, §13.1–§13.4, §14, plan gaps G6 and G14,
  `docs/specs/tacho/spec.md` §6, `packages/run-ledger/src/frame-body.ts`,
  `packages/run-ledger/src/evidence-store.ts`,
  `packages/tacho/src/evidence/replay-grade.ts`,
  `packages/handlers/src/lib/tacho-replay.ts`,
  `packages/database/atlas/migrations/20260914230000_run_recorder_replay.sql`

## Context

The Mission Control spec asks for one run record: every frame with its body,
retained at full fidelity, sealed once, graded once, verifiable offline. The
tree at the time of #2952 held two recorders with no bodies. The evidence
ledger (`agent.agent_runs`, `agent.agent_run_attempts`,
`agent.agent_run_events`, `agent.agent_run_attempt_seals` in Postgres) held
receipt payloads and a digest chain for runs the platform witnesses through
its own producers; ClickHouse `tacho_events` held the hash-chained envelopes
of wrapped sessions. Neither store held the bytes a frame was about. Nothing
computed a replay grade: `tacho.sessions.replay_grade` existed as a column
nobody wrote, and the ledger seal had no grade at all.

The spec places `:Run` and `:Frame` in the organisation's Neo4j database
(App. B). Moving the ledger there, or adding a projection, was the first of
three decisions #2952 left to the maintainer. The second was the retention
default and the shape of the per-workspace `digest_only` opt-down (spec
§13.1). The third was whether fork replay ships in this revision, given that
the harness that consumes a cassette lives outside this repo (ADR-043).

## Decision

### 1. The Postgres ledger stays the write path; bodies go to object storage now; the graph projection waits

The run record for this revision is the Postgres ledger for platform-witnessed
runs and ClickHouse `tacho_events` for wrapped sessions, read through one
frame projection (`RunFrame` in `@oxagen/run-ledger`; the reader in
`packages/handlers/src/lib/run-read.ts`). Frame bodies, archive segments and
export bundles live in object storage through `@oxagen/storage`
(`packages/run-ledger/src/evidence-store.ts`).

No Neo4j projection of `:Run` or `:Frame` is added. The first reader that
needs graph edges over runs is the run context window (plan gap G10), and the
projection is built with it. Nothing in this revision reads a run from the
graph, so a projection written now would be unbound code.

Every object is keyed tenant-first
(`evidence/<orgId>/<workspaceId>/bodies/<sha256>`), so a reference cannot
resolve inside another tenant's prefix, and a body reference
(`evb:v1:<key id>:<sha256>`) carries the id of the key-encryption key that
wrapped its data key. The blob store is one shared driver today: the
data-plane resolver (`packages/tenancy/src/data-plane.ts`) names Postgres,
Neo4j and ClickHouse planes and no blob plane, and this revision does not add
one. When ADR-042 gains a blob plane and a per-organisation KEK, an existing
reference still decrypts by routing on its key id alone, and a new object
lands on the organisation's plane through the same `evidenceStore()` seam.

### 2. Bodies are retained by default; the clock is seven years from the seal; `digest_only` is the pinned retention policy, recorded as a completeness gap

A frame's content is redacted, digested, and written before any row
references it (`prepareFrameBody`, `packages/run-ledger/src/frame-body.ts`;
`verifyBatchBodies`, `packages/handlers/src/lib/tacho-replay.ts`). The row
records the digest in every case, the object reference only when the run's
retention policy kept the class. A policy that kept digests alone still
leaves a chain that verifies against a body nobody retained.

The default retention clock is seven years from the seal (spec §13.1). The
clock is a policy of the retention policy version a run pins
(`evidence.retention_policy_versions.ttl_days`); no job deletes a body in
this revision, and erasure is crypto-shredding of the organisation's key
(spec §13, the audit lane), which leaves the digest chain intact.

`digest_only` is not a new column on workspace settings. The workspace's
fidelity is the `mode` of the latest `evidence.retention_policy_versions`
row it pinned (`readWorkspaceRetention`,
`packages/handlers/src/lib/tacho-host.ts`); a workspace that has pinned no
policy retains every content class. A `digest_only` workspace records the
gap `digest_only` on every seal, which grades the run `inspect`; the tacho
bundle carries the same clause to the host, so a host in that workspace
ships no bytes and a batch that does is refused body by body.

The hot window for frame rows is thirteen months from the seal (spec §13.2,
§13.3). `evidence.frame-compaction` (`packages/inngest-functions`) removes the
hot rows of a seal older than the window through the SECURITY DEFINER
function `agent.compact_sealed_attempt_events`, the one delete path on an
event log the application role otherwise cannot delete from. The seal keeps
`event_count`, `merkle_root`, `archive_segment_ref` and the rollup
(`model_calls`, `tool_calls`, `turns`); a compacted attempt is read from its
archive segment.

### 3. The grade is computed once at seal; `inspect`, `view` and `bisect` ship now; `fork` mints the attempt behind the recorded grade and the harness replays it

The replay grade is a closed, ordered vocabulary (`inspect < view < fork <
retry`) computed by one pure function (`computeReplayGrade`,
`packages/tacho/src/evidence/replay-grade.ts`) that the ledger seal, the
tacho seal and every handler gating on a grade share:

- `inspect`: frames only. Any of `digest_only`, `body_missing`,
  `model_calls`, `hooks_partial`, `unobserved_tail`, `chain_break`,
  `telemetry_gap`.
- `view`: every body present. A `tool_bodies` gap, or any enforcement tier
  below `gateway`, stops here.
- `fork`: `view` plus tool result bodies on a `gateway`-tier run.
- `retry`: `fork` plus a harness that reports a reproducible run; nothing
  infers it.

A gap kind outside the vocabulary refuses to grade. The grade is written with
the Merkle root and the archive segment reference, once, at seal; a seal
written before the recorder graded stays `NULL`; nothing raises a grade
afterwards, and an interface renders the recorded word and never a stronger
one.

`get_run_frame_body`, `get_run_transcript` and `bisect_runs` ship in this
revision and work at grade `inspect` and above (bisect reads keys from
receipts, never bodies). `fork_run` ships behind the recorded grade: it
refuses with `conflict` when the seal's grade is below `fork`, when the
branch point lies past the seal, or when a frame before the branch point
carried content without a retained body. What it does when it passes is mint
a new attempt with the sealed attempt's engine identity, `resumed_from` the
sealed attempt and `forked_from_run_seq` at the branch point. Replaying
frames 0–N and serving tool results from the cassette is the harness's work
(ADR-043); Oxagen records the fork's provenance and gates it. The
`run-controls-steering` lane wires the harness side.

A ledger run seals at the `harness` tier in this revision
(`gradeSealedAttempt`, `packages/run-ledger/src/frame-body.ts`): its frames
are submitted by an engine Oxagen did not host, so the grade caps at `view`
and `fork_run` refuses every ledger run until a gateway-observed ledger run
exists. A wrapped session at the `gateway` tier with every body can seal
`fork`, and the word is recorded; forking a wrapped session is not a
capability of this revision because no attempt row exists to mint for it.

## Consequences

- One recorder rule for two stores. A frame from either store carries the
  same body reference shape and the same fidelity word; a capability over a
  recording reads it through one projection and does not know which store
  minted it.
- The digest chain is complete whether or not bodies were kept: a
  `digest_only` workspace loses `view` and above and keeps tamper evidence.
- A grade is a record, never a computation at read time. The witness (#2955),
  the fleet's Replay column and the Run page's grade ladder all read the
  sealed word.
- The migration is expand-only and every invariant this ADR states that a row
  can carry is a CHECK constraint on the row: fidelity implies a body
  reference, a body reference implies a digest and a length, a grade implies
  a Merkle root, an archive segment and a rollup, a summary implies its model
  and instant, a fork implies a resumed-from attempt.
- The graph projection, the blob data plane and the per-organisation KEK are
  deferred, and each has its consumer named (G10, ADR-042). The reference
  formats already carry what those consumers need.
- A body deletion job does not exist. When the seven-year default is reached
  for a tenant that has not set a longer period, the audit lane's erasure
  path is the mechanism, and it is a key destruction, never a row delete.
